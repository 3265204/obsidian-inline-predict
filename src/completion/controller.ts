/**
 * Completion controller: public wiring surface for the editor integration.
 *
 * `CompletionController` is the per-editor session class (see `./session`); this module keeps the
 * plugin-facing option/port types and the `createCompletionIntegration` factory that
 * `main.ts` calls once, then registers the returned extension on the editor.
 */

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { createGhostTextExtension } from '../editor/ghost-text';
import { createObserverExtension } from '../editor/observer';
import type {
	EditorMode,
	SchedulerEvents,
	SchedulerPort,
	SchedulerStatus,
	SuggestionFeedback,
} from '../core/types';
import type { PredictiveSettings } from '../settings/schema';
import { CompletionController } from './session';

export { CompletionController } from './session';

export interface CompletionExtensionOptions {
	createScheduler(events: SchedulerEvents): SchedulerPort;
	getSettings(): PredictiveSettings;
	getDocInfo(view: EditorView): { docId: string; mode: EditorMode; language: string | null };
	onStatus?(status: SchedulerStatus): void;
	onFeedback?(event: SuggestionFeedback): void;
	onNotice?(message: string): void;
	onActiveController?(controller: CompletionController | null): void;
}

export interface CompletionIntegration {
	extension: Extension;
	requestNow(): boolean;
	acceptAll(): boolean;
	acceptWord(): boolean;
	acceptSentence(): boolean;
	acceptLine(): boolean;
	dismiss(): boolean;
	/** Re-read settings after a change; safe to call from `main.ts` on settings updates. */
	refresh(): void;
	destroy(): void;
}

/**
 * Create the editor-side completion integration. The extension observes each editor view,
 * creates one scheduler per view, and clears the active controller on focus changes so commands
 * from `main.ts` target the right editor.
 */
export function createCompletionIntegration(
	options: CompletionExtensionOptions,
): CompletionIntegration {
	const controllers = new WeakMap<EditorView, CompletionController>();
	const live = new Set<CompletionController>();
	let destroyed = false;
	let active: CompletionController | null = null;

	const announceActive = (controller: CompletionController | null): void => {
		if (active === controller) return;
		active = controller;
		try {
			options.onActiveController?.(controller);
		} catch {
			// Optional callback.
		}
	};

	const currentController = (): CompletionController | null => (destroyed ? null : active);

	function requestNow(): boolean {
		return currentController()?.requestNow() ?? false;
	}

	function acceptAll(): boolean {
		return currentController()?.acceptAll() ?? false;
	}

	function acceptWord(): boolean {
		return currentController()?.acceptWord() ?? false;
	}

	function acceptSentence(): boolean {
		return currentController()?.acceptSentence() ?? false;
	}

	function acceptLine(): boolean {
		return currentController()?.acceptLine() ?? false;
	}

	function dismiss(): boolean {
		return currentController()?.dismiss() ?? false;
	}

	const observerExtension = createObserverExtension({
		getDocInfo: (view) => options.getDocInfo(view),
		onInit: (view) => {
			if (destroyed) return;
			const controller = new CompletionController(view, options);
			controllers.set(view, controller);
			live.add(controller);
			if (active === null) announceActive(controller);
			try {
				const scheduler = options.createScheduler({
					onSuggestion: (suggestion) => controller.handleSuggestion(suggestion),
					onStatus: (status) => {
						try {
							options.onStatus?.(status);
						} catch {
							// Optional callback.
						}
					},
				});
				controller.attachScheduler(scheduler);
			} catch {
				// Without a scheduler the controller still renders nothing; editing is unaffected.
				controller.attachScheduler(null);
			}
		},
		onSnapshot: (view, snapshot) => {
			if (destroyed) return;
			controllers.get(view)?.handleSnapshot(snapshot);
		},
		onCursor: (view, snapshot) => {
			if (destroyed) return;
			controllers.get(view)?.handleCursor(snapshot);
		},
		onComposition: (view, composing) => {
			if (destroyed) return;
			controllers.get(view)?.handleComposition(composing);
		},
		onFocus: (view) => {
			if (destroyed) return;
			const controller = controllers.get(view);
			if (controller !== undefined) announceActive(controller);
		},
		onBlur: (view) => {
			if (destroyed) return;
			const controller = controllers.get(view);
			if (controller !== undefined && active === controller) announceActive(null);
		},
		onDestroy: (view) => {
			const controller = controllers.get(view);
			if (controller === undefined) return;
			controllers.delete(view);
			live.delete(controller);
			if (active === controller) announceActive(null);
			controller.destroy();
		},
	});

	const ghostExtension = createGhostTextExtension({
		accept: acceptAll,
		acceptWord,
		acceptSentence,
		acceptLine,
		dismiss: () => {
			dismiss();
		},
	});

	const extension: Extension = [observerExtension, ghostExtension];

	return {
		extension,
		requestNow,
		acceptAll,
		acceptWord,
		acceptSentence,
		acceptLine,
		dismiss,
		refresh: () => {
			if (destroyed) return;
			for (const controller of live) controller.refresh();
		},
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			announceActive(null);
			for (const controller of live) controller.destroy();
			live.clear();
		},
	};
}
