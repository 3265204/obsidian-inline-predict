// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	createGhostTextExtension,
	getGhostSuggestion,
	setGhostSuggestion,
	type GhostTextOptions,
} from '../../src/editor/ghost-text';
import { t } from '../../src/i18n';
import type { ActiveSuggestion } from '../../src/core/types';

const openViews: EditorView[] = [];

interface Harness {
	view: EditorView;
	calls: string[];
}

function mount(doc = 'hello', cursor = doc.length): Harness {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const calls: string[] = [];
	const options: GhostTextOptions = {
		accept: () => {
			calls.push('accept');
			return true;
		},
		acceptWord: () => {
			calls.push('word');
			return true;
		},
		acceptSentence: () => {
			calls.push('sentence');
			return true;
		},
		acceptLine: () => {
			calls.push('line');
			return true;
		},
		dismiss: () => {
			calls.push('dismiss');
		},
	};
	const view = new EditorView({
		state: EditorState.create({
			doc,
			selection: { anchor: cursor },
			extensions: [createGhostTextExtension(options)],
		}),
		parent,
	});
	openViews.push(view);
	return { view, calls };
}

function suggestion(remainingText: string, anchor: number, docVersion = 0): ActiveSuggestion {
	return {
		candidate: {
			requestId: 11,
			text: remainingText,
			docId: 'note.md',
			docVersion,
			anchor,
			finishReason: 'stop',
			usage: null,
			modelId: 'test-model',
			createdAt: Date.now(),
			latencyMs: 10,
			source: 'model',
			degraded: false,
		},
		remainingText,
		anchor,
		docVersion,
		reusedFromRequestId: null,
	};
}

function ghostElement(view: EditorView): Element | null {
	return view.contentDOM.querySelector('.predictive-ghost');
}

function keydown(view: EditorView, key: string): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	view.contentDOM.dispatchEvent(event);
	return event;
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

describe('ghost text state field', () => {
	it('renders a suggestion as a widget without touching the document', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		expect(getGhostSuggestion(harness.view.state)?.remainingText).toBe(' world');
		expect(harness.view.state.doc.toString()).toBe('hello');
		const ghost = ghostElement(harness.view);
		expect(ghost).not.toBeNull();
		expect(ghost?.textContent?.startsWith(' world')).toBe(true);
	});

	it('clears the widget when the suggestion becomes null', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		expect(ghostElement(harness.view)).not.toBeNull();
		setGhostSuggestion(harness.view, null);
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(ghostElement(harness.view)).toBeNull();
	});

	it('drops stale decorations when the document changes', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		harness.view.dispatch({ changes: { from: 5, insert: '!' } });
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
		expect(ghostElement(harness.view)).toBeNull();
		expect(harness.view.state.doc.toString()).toBe('hello!');
	});

	it('clamps an out-of-range anchor and ignores empty suggestions', () => {
		const harness = mount('hi');
		setGhostSuggestion(harness.view, suggestion('abc', 999));
		expect(getGhostSuggestion(harness.view.state)?.anchor).toBe(2);
		expect(ghostElement(harness.view)).not.toBeNull();
		setGhostSuggestion(harness.view, suggestion('', 2));
		expect(getGhostSuggestion(harness.view.state)).toBeNull();
	});

	it('renders multi-line text with pre-wrap and no pointer events on the text', () => {
		const harness = mount('intro');
		setGhostSuggestion(harness.view, suggestion('\n- one\n- two', 5));
		const ghost = ghostElement(harness.view) as HTMLElement | null;
		expect(ghost).not.toBeNull();
		expect(ghost?.textContent?.startsWith('\n- one\n- two')).toBe(true);
		expect(ghost?.style.whiteSpace).toBe('pre-wrap');
		expect(ghost?.style.pointerEvents).toBe('none');
		expect(harness.view.state.doc.toString()).toBe('intro');
	});

	it('renders a touch-accept chip with an i18n aria-label', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		const chip = harness.view.contentDOM.querySelector('.predictive-ghost-accept');
		expect(chip).not.toBeNull();
		expect(chip?.getAttribute('aria-label')).toBe(t('ghost.tapToAccept'));
		expect((chip as HTMLElement).style.pointerEvents).toBe('auto');
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		chip?.dispatchEvent(mouseDown);
		expect(mouseDown.defaultPrevented).toBe(true);
		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		chip?.dispatchEvent(click);
		expect(harness.calls).toContain('accept');
		expect(harness.view.state.doc.toString()).toBe('hello');
	});
});

describe('ghost text keymap', () => {
	it('leaves Tab untouched when no suggestion exists', () => {
		const harness = mount('hello');
		const event = keydown(harness.view, 'Tab');
		expect(event.defaultPrevented).toBe(false);
		expect(harness.calls).toEqual([]);
	});

	it('accepts on Tab only when a suggestion exists', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		const event = keydown(harness.view, 'Tab');
		expect(harness.calls).toEqual(['accept']);
		expect(event.defaultPrevented).toBe(true);
	});

	it('leaves Escape untouched when no suggestion exists', () => {
		const harness = mount('hello');
		const event = keydown(harness.view, 'Escape');
		expect(event.defaultPrevented).toBe(false);
		expect(harness.calls).toEqual([]);
	});

	it('dismisses on Escape when a suggestion exists', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		const event = keydown(harness.view, 'Escape');
		expect(harness.calls).toEqual(['dismiss']);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('ghost text and IME composition', () => {
	it('hides via CSS and ignores Tab while composing, without dispatching a transaction', () => {
		const harness = mount('hello');
		setGhostSuggestion(harness.view, suggestion(' world', 5));
		expect(ghostElement(harness.view)).not.toBeNull();

		const dispatch = vi.spyOn(harness.view, 'dispatch');
		harness.view.contentDOM.dispatchEvent(new Event('compositionstart'));

		// The decoration intentionally stays in state; CSS hides it. Dispatching here would abort
		// the IME composition (the bug this test guards).
		expect(dispatch).not.toHaveBeenCalled();
		expect(harness.view.dom.classList.contains('predictive-composing')).toBe(true);
		expect(ghostElement(harness.view)).not.toBeNull();
		expect(getGhostSuggestion(harness.view.state)).not.toBeNull();

		const tab = keydown(harness.view, 'Tab');
		expect(harness.calls).toEqual([]);
		expect(tab.defaultPrevented).toBe(false);

		harness.view.contentDOM.dispatchEvent(new Event('compositionend'));
		expect(harness.view.dom.classList.contains('predictive-composing')).toBe(false);
		expect(ghostElement(harness.view)).not.toBeNull();
	});
});
