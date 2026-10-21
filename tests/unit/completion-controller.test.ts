// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	createCompletionIntegration,
	type CompletionController,
	type CompletionIntegration,
} from '../../src/completion/controller';
import { getGhostSuggestion } from '../../src/editor/ghost-text';
import { applySettingsPatch, DEFAULT_SETTINGS } from '../../src/settings/schema';
import type { DeepPartial, PredictiveSettings } from '../../src/settings/schema';
import type {
	ActiveSuggestion,
	EditorSnapshot,
	SchedulerEvents,
	SchedulerPort,
	SchedulerStatus,
	SuggestionFeedback,
} from '../../src/core/types';

const openViews: EditorView[] = [];

class FakeScheduler implements SchedulerPort {
	latestSnapshot: EditorSnapshot | null = null;
	readonly updates: EditorSnapshot[] = [];
	readonly cursorUpdates: EditorSnapshot[] = [];
	readonly accepted: { text: string; full: boolean }[] = [];
	rejected = 0;
	requestNowCount = 0;
	refreshed = 0;
	disposed = false;
	events: SchedulerEvents;

	constructor(events: SchedulerEvents) {
		this.events = events;
	}

	update(snapshot: EditorSnapshot): void {
		this.latestSnapshot = snapshot;
		this.updates.push(snapshot);
	}

	updateCursor(snapshot: EditorSnapshot): void {
		this.latestSnapshot = snapshot;
		this.cursorUpdates.push(snapshot);
	}

	notifyAccepted(text: string, full: boolean): void {
		this.accepted.push({ text, full });
	}

	notifyRejected(): void {
		this.rejected++;
	}

	current(): ActiveSuggestion | null {
		return null;
	}

	requestNow(): void {
		this.requestNowCount++;
	}

	refresh(): void {
		this.refreshed++;
	}

	setEvents(events: SchedulerEvents): void {
		this.events = events;
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface Harness {
	view: EditorView;
	integration: CompletionIntegration;
	scheduler: FakeScheduler;
	feedback: SuggestionFeedback[];
	statuses: SchedulerStatus[];
	activeLog: (CompletionController | null)[];
	setSettings: (patch: DeepPartial<PredictiveSettings>) => void;
}

function setup(doc = 'hello', cursor = doc.length, docId = 'note.md'): Harness {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const feedback: SuggestionFeedback[] = [];
	const statuses: SchedulerStatus[] = [];
	const activeLog: (CompletionController | null)[] = [];
	const schedulers: FakeScheduler[] = [];
	let currentSettings: PredictiveSettings = DEFAULT_SETTINGS;
	const integration = createCompletionIntegration({
		createScheduler: (events) => {
			const scheduler = new FakeScheduler(events);
			schedulers.push(scheduler);
			return scheduler;
		},
		getSettings: () => currentSettings,
		getDocInfo: () => ({ docId, mode: 'source', language: 'markdown' }),
		onStatus: (status) => statuses.push(status),
		onFeedback: (event) => feedback.push(event),
		onActiveController: (controller) => activeLog.push(controller),
	});
	const view = new EditorView({
		state: EditorState.create({
			doc,
			selection: { anchor: cursor },
			extensions: [integration.extension],
		}),
		parent,
	});
	openViews.push(view);
	const scheduler = schedulers[0];
	if (scheduler === undefined) throw new Error('scheduler was not created');
	return {
		view,
		integration,
		scheduler,
		feedback,
		statuses,
		activeLog,
		setSettings: (patch) => {
			currentSettings = applySettingsPatch(currentSettings, patch);
		},
	};
}

async function ready(doc = 'hello', cursor?: number): Promise<Harness> {
	const harness = setup(doc, cursor);
	// The observer emits its initial file-open snapshot on a microtask.
	await Promise.resolve();
	return harness;
}

function latestSnapshot(harness: Harness): EditorSnapshot {
	const snapshot = harness.scheduler.latestSnapshot;
	if (snapshot === null) throw new Error('no snapshot forwarded');
	return snapshot;
}

function suggestion(
	remainingText: string,
	anchor: number,
	docVersion: number,
): ActiveSuggestion {
	return {
		candidate: {
			requestId: 42,
			text: remainingText,
			docId: 'note.md',
			docVersion,
			anchor,
			finishReason: 'stop',
			usage: null,
			modelId: 'test-model',
			createdAt: Date.now(),
			latencyMs: 30,
			source: 'model',
			degraded: false,
		},
		remainingText,
		anchor,
		docVersion,
		reusedFromRequestId: null,
	};
}

function showSuggestion(harness: Harness, remainingText: string): ActiveSuggestion {
	const snapshot = latestSnapshot(harness);
	const value = suggestion(remainingText, snapshot.cursor, snapshot.docVersion);
	harness.scheduler.events.onSuggestion(value);
	return value;
}

function last<T>(items: readonly T[]): T {
	const value = items[items.length - 1];
	if (value === undefined) throw new Error('expected a value');
	return value;
}

afterEach(() => {
	for (const view of openViews.splice(0)) {
		try {
			view.destroy();
		} catch {
			// Already destroyed by the test.
		}
	}
	document.body.innerHTML = '';
});

describe('createCompletionIntegration', () => {
	it('creates one scheduler per editor and forwards document snapshots', async () => {
		const harness = await ready('hello');
		expect(harness.scheduler.updates).toHaveLength(1);
		expect(latestSnapshot(harness).trigger).toBe('file-open');

		harness.view.dispatch({ changes: { from: 0, insert: 'x' } });
		const snapshot = latestSnapshot(harness);
		expect(snapshot.trigger).toBe('doc-change');
		expect(snapshot.docVersion).toBe(1);
	});

	it('forwards selection-only changes to updateCursor', async () => {
		const harness = await ready('hello');
		harness.view.dispatch({ selection: { anchor: 2 } });
		expect(harness.scheduler.cursorUpdates).toHaveLength(1);
		expect(last(harness.scheduler.cursorUpdates).cursor).toBe(2);
	});

	it('renders a scheduler suggestion and drops stale ones', async () => {
		const harness = await ready('hello');
		const shown = showSuggestion(harness, ' world');
		expect(getGhostSuggestion(harness.view.state)?.remainingText).toBe(' world');

		harness.view.dispatch({ changes: { from: 5, insert: 'q' } });
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.feedback).toContainEqual(
			expect.objectContaining({ type: 'ignored' }) as SuggestionFeedback,
		);

		// Late result generated against the previous version/cursor is ignored.
		harness.scheduler.events.onSuggestion(shown);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
	});

	it('keeps the ghost alive while the user types the suggested prefix', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world');

		harness.view.dispatch({
			changes: { from: 5, insert: ' ' },
			selection: { anchor: 6 },
		});
		await Promise.resolve();
		expect(getGhostSuggestion(harness.view.state)?.remainingText).toBe('world');
		expect(getGhostSuggestion(harness.view.state)?.anchor).toBe(6);
		expect(harness.feedback).toHaveLength(0);

		harness.view.dispatch({
			changes: { from: 6, insert: 'w' },
			selection: { anchor: 7 },
		});
		await Promise.resolve();
		expect(getGhostSuggestion(harness.view.state)?.remainingText).toBe('orld');
		expect(getGhostSuggestion(harness.view.state)?.anchor).toBe(7);

		harness.view.dispatch({
			changes: { from: 7, insert: 'X' },
			selection: { anchor: 8 },
		});
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(last(harness.feedback).type).toBe('ignored');
	});

	it('accepts the whole suggestion exactly once', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world');

		expect(harness.integration.acceptAll()).toBe(true);
		expect(harness.view.state.doc.toString()).toBe('hello world');
		expect(harness.view.state.selection.main.head).toBe(11);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.scheduler.accepted).toEqual([{ text: ' world', full: true }]);
		expect(last(harness.feedback).type).toBe('accept-full');

		expect(harness.integration.acceptAll()).toBe(false);
	});

	it('partial accept leaves the remainder rendered with a shifted anchor', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world again');

		expect(harness.integration.acceptWord()).toBe(true);
		expect(harness.view.state.doc.toString()).toBe('hello world ');
		expect(harness.view.state.selection.main.head).toBe(12);
		const ghost = getGhostSuggestion(harness.view.state);
		expect(ghost?.remainingText).toBe('again');
		expect(ghost?.anchor).toBe(12);
		expect(ghost?.docVersion).toBe(latestSnapshot(harness).docVersion);
		expect(harness.scheduler.accepted).toEqual([{ text: ' world ', full: false }]);
		expect(last(harness.feedback).type).toBe('accept-partial');

		expect(harness.integration.acceptAll()).toBe(true);
		expect(harness.view.state.doc.toString()).toBe('hello world again');
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.scheduler.accepted).toEqual([
			{ text: ' world ', full: false },
			{ text: 'again', full: true },
		]);
		expect(last(harness.feedback).type).toBe('accept-full');
	});

	it('dismiss clears the ghost and reports a rejection', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world');

		expect(harness.integration.dismiss()).toBe(true);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.scheduler.rejected).toBe(1);
		expect(last(harness.feedback).type).toBe('reject');
		expect(harness.integration.dismiss()).toBe(false);
	});

	it('ignores suggestions and accept commands while composing', async () => {
		const harness = await ready('hello');
		harness.view.contentDOM.dispatchEvent(new Event('compositionstart'));
		harness.scheduler.events.onSuggestion(
			suggestion(' world', latestSnapshot(harness).cursor, latestSnapshot(harness).docVersion),
		);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();

		harness.view.contentDOM.dispatchEvent(new Event('compositionend'));
		await Promise.resolve();
		harness.scheduler.events.onSuggestion(
			suggestion(' world', latestSnapshot(harness).cursor, latestSnapshot(harness).docVersion),
		);
		expect(getGhostSuggestion(harness.view.state)).not.toBeNull();
		expect(harness.view.contentDOM.querySelector('.predictive-ghost')).not.toBeNull();

		harness.view.contentDOM.dispatchEvent(new Event('compositionstart'));
		// The existing ghost is hidden declaratively (no transaction during composition).
		expect(harness.view.dom.classList.contains('predictive-composing')).toBe(true);
		expect(harness.integration.acceptAll()).toBe(false);
		expect(harness.integration.dismiss()).toBe(false);
		expect(harness.view.state.doc.toString()).toBe('hello');
		harness.view.contentDOM.dispatchEvent(new Event('compositionend'));
	});

	it('forwards scheduler status and forces a request', async () => {
		const harness = await ready('hello');
		expect(harness.integration.requestNow()).toBe(true);
		expect(harness.scheduler.requestNowCount).toBe(1);
		harness.scheduler.events.onStatus('requesting');
		expect(harness.statuses).toEqual(['requesting']);
	});

	it('tracks the active controller on focus and blur', async () => {
		const harness = await ready('hello');
		const first = last(harness.activeLog);
		expect(first).not.toBeNull();

		harness.view.contentDOM.dispatchEvent(new FocusEvent('focus'));
		harness.view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		expect(last(harness.activeLog)).toBeNull();

		harness.view.contentDOM.dispatchEvent(new FocusEvent('focus'));
		expect(last(harness.activeLog)).not.toBeNull();
	});

	it('disposes the scheduler and ignores events after destroy', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world');
		harness.integration.destroy();
		expect(harness.scheduler.disposed).toBe(true);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(last(harness.activeLog)).toBeNull();
		expect(harness.integration.requestNow()).toBe(false);
		expect(harness.integration.acceptAll()).toBe(false);
		expect(harness.integration.dismiss()).toBe(false);

		// A late scheduler callback must be a no-op, not a throw.
		expect(() => {
			harness.scheduler.events.onSuggestion(suggestion(' more', 5, 0));
		}).not.toThrow();
	});

	it('does not schedule predictions when completion is disabled', async () => {
		const harness = await ready('hello');
		const updatesBefore = harness.scheduler.updates.length;
		harness.setSettings({ completion: { enabled: false } });
		harness.view.dispatch({
			changes: { from: 5, insert: 'x' },
			selection: { anchor: 6 },
		});
		// The scheduler is paused (timer cancelled) but receives no new trigger.
		expect(harness.scheduler.updates).toHaveLength(updatesBefore);
		expect(harness.scheduler.cursorUpdates).toHaveLength(1);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.integration.requestNow()).toBe(false);
	});

	it('supports manual-only mode without auto-scheduling', async () => {
		const harness = await ready('hello');
		harness.setSettings({ completion: { autoTrigger: false } });
		const updatesBefore = harness.scheduler.updates.length;
		harness.view.dispatch({
			changes: { from: 5, insert: 'x' },
			selection: { anchor: 6 },
		});
		expect(harness.scheduler.updates).toHaveLength(updatesBefore);
		expect(harness.scheduler.cursorUpdates).toHaveLength(1);
		expect(harness.integration.requestNow()).toBe(true);
		expect(harness.scheduler.requestNowCount).toBe(1);
	});

	it('refresh() clears the ghost when completion is turned off', async () => {
		const harness = await ready('hello');
		showSuggestion(harness, ' world');
		expect(getGhostSuggestion(harness.view.state)).not.toBeNull();
		harness.setSettings({ completion: { enabled: false } });
		harness.integration.refresh();
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(harness.integration.acceptAll()).toBe(false);
	});
});

describe('context sufficiency gate', () => {
	it('两个前文字符会进入临时缓冲区的自动调度', async () => {
		const harness = setup('线性', undefined, '');
		await Promise.resolve();
		expect(harness.scheduler.updates.length).toBeGreaterThan(0);
	});
	it('defers automatic requests in an untitled buffer with too little context', async () => {
		const harness = setup('线', undefined, '');
		await Promise.resolve();
		expect(harness.scheduler.updates).toHaveLength(0);
		expect(harness.scheduler.cursorUpdates.length).toBeGreaterThan(0);

		// Manual trigger still works: the user explicitly asked for a prediction.
		expect(harness.integration.requestNow()).toBe(true);
		expect(harness.scheduler.requestNowCount).toBe(1);
	});

	it('forwards automatic updates for named notes', async () => {
		const harness = setup('hello', undefined, 'notes/linear.md');
		await Promise.resolve();
		expect(harness.scheduler.updates.length).toBeGreaterThan(0);
	});
});
