// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { PREFIX_CAPTURE_CHARS, SUFFIX_CAPTURE_CHARS } from '../../src/core/constants';
import { createEditorObserver, type EditorDocInfo } from '../../src/editor/observer';
import type { EditorSnapshot } from '../../src/core/types';

const DEFAULT_INFO: EditorDocInfo = { docId: 'note.md', mode: 'source', language: 'markdown' };
const openViews: EditorView[] = [];

function mount(
	doc: string,
	options: {
		info?: () => EditorDocInfo;
		cursor?: number;
	} = {},
): {
	view: EditorView;
	snapshots: EditorSnapshot[];
	cursors: EditorSnapshot[];
	compositions: boolean[];
	destroyCount: () => number;
} {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const snapshots: EditorSnapshot[] = [];
	const cursors: EditorSnapshot[] = [];
	const compositions: boolean[] = [];
	let destroyed = 0;
	const info = options.info ?? (() => DEFAULT_INFO);
	const view = new EditorView({
		state: EditorState.create({
			doc,
			selection: { anchor: options.cursor ?? doc.length },
			extensions: [
				createEditorObserver({
					getDocInfo: () => info(),
					onSnapshot: (snapshot) => snapshots.push(snapshot),
					onCursor: (snapshot) => cursors.push(snapshot),
					onComposition: (composing) => compositions.push(composing),
					onDestroy: () => {
						destroyed++;
					},
				}),
			],
		}),
		parent,
	});
	openViews.push(view);
	return { view, snapshots, cursors, compositions, destroyCount: () => destroyed };
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

function last<T>(items: readonly T[]): T {
	const value = items[items.length - 1];
	if (value === undefined) throw new Error('expected a value');
	return value;
}

describe('createEditorObserver', () => {
	it('emits an initial file-open snapshot after construction', async () => {
		const harness = mount('hello');
		expect(harness.snapshots).toHaveLength(0);
		await Promise.resolve();
		const snapshot = last(harness.snapshots);
		expect(snapshot.trigger).toBe('file-open');
		expect(snapshot.docId).toBe('note.md');
		expect(snapshot.docVersion).toBe(0);
		expect(snapshot.cursor).toBe(5);
		expect(snapshot.line).toBe(0);
		expect(snapshot.ch).toBe(5);
		expect(snapshot.language).toBe('markdown');
		expect(snapshot.mode).toBe('source');
	});

	it('bumps docVersion once per doc-changing transaction and reports lastEdit', async () => {
		const harness = mount('hello');
		await Promise.resolve();
		harness.snapshots.length = 0;

		harness.view.dispatch({
			changes: { from: 5, insert: ' world' },
			selection: { anchor: 11 },
		});
		expect(harness.snapshots).toHaveLength(1);
		const first = last(harness.snapshots);
		expect(first.trigger).toBe('doc-change');
		expect(first.docVersion).toBe(1);
		expect(first.cursor).toBe(11);
		expect(first.prefix).toBe('hello world');
		expect(first.lastEdit).toMatchObject({
			from: 5,
			to: 5,
			insertedText: ' world',
			removedLength: 0,
		});

		harness.view.dispatch({
			changes: { from: 0, to: 5, insert: 'bye' },
			selection: { anchor: 9 },
		});
		expect(harness.snapshots).toHaveLength(2);
		const second = last(harness.snapshots);
		expect(second.docVersion).toBe(2);
		expect(second.lastEdit).toMatchObject({ from: 0, to: 5, removedLength: 5 });
	});

	it('emits cursor snapshots (not doc snapshots) on selection changes', async () => {
		const harness = mount('hello');
		await Promise.resolve();
		harness.snapshots.length = 0;

		harness.view.dispatch({ selection: { anchor: 3 } });
		expect(harness.snapshots).toHaveLength(0);
		expect(harness.cursors).toHaveLength(1);
		const snapshot = last(harness.cursors);
		expect(snapshot.trigger).toBe('selection');
		expect(snapshot.docVersion).toBe(0);
		expect(snapshot.cursor).toBe(3);
		expect(snapshot.lineTextBefore).toBe('hel');
		expect(snapshot.lineTextAfter).toBe('lo');
	});

	it('caps prefix and suffix around the cursor', async () => {
		const doc =
			'a'.repeat(PREFIX_CAPTURE_CHARS + 25) + 'b'.repeat(SUFFIX_CAPTURE_CHARS + 25);
		const cursor = PREFIX_CAPTURE_CHARS + 5;
		const harness = mount(doc, { cursor });
		await Promise.resolve();
		const snapshot = last(harness.snapshots);
		expect(snapshot.prefix).toHaveLength(PREFIX_CAPTURE_CHARS);
		expect(snapshot.prefixOffset).toBe(5);
		expect(snapshot.suffix).toHaveLength(SUFFIX_CAPTURE_CHARS);
		expect(snapshot.prefix + snapshot.suffix).not.toBe(doc);
	});

	it('reports IME composition state and a composition-end snapshot', async () => {
		const harness = mount('abc');
		await Promise.resolve();
		harness.snapshots.length = 0;

		harness.view.contentDOM.dispatchEvent(new Event('compositionstart'));
		expect(harness.compositions).toEqual([true]);

		harness.view.dispatch({ changes: { from: 3, insert: 'd' } });
		expect(last(harness.snapshots).isComposing).toBe(true);

		harness.view.contentDOM.dispatchEvent(new Event('compositionend'));
		expect(harness.compositions).toEqual([true, false]);
		await Promise.resolve();
		const snapshot = last(harness.snapshots);
		expect(snapshot.trigger).toBe('composition-end');
		expect(snapshot.isComposing).toBe(false);
	});

	it('detects fenced code blocks in the captured prefix', async () => {
		const inside = mount('intro\n```ts\nconst x = 1;\nmore');
		await Promise.resolve();
		expect(last(inside.snapshots).inCodeBlock).toBe(true);

		const after = mount('```\ncode\n```\nafter');
		await Promise.resolve();
		expect(last(after.snapshots).inCodeBlock).toBe(false);

		const plain = mount('plain text');
		await Promise.resolve();
		expect(last(plain.snapshots).inCodeBlock).toBe(false);
	});

	it('detects math blocks in the captured prefix', async () => {
		const math = mount('text\n$$\nx = 1\nstill');
		await Promise.resolve();
		expect(last(math.snapshots).inMathBlock).toBe(true);

		const plain = mount('text only');
		await Promise.resolve();
		expect(last(plain.snapshots).inMathBlock).toBe(false);
	});

	it('emits a file-open snapshot when the doc id changes without a document edit', async () => {
		let info: EditorDocInfo = DEFAULT_INFO;
		const harness = mount('abc', { info: () => info });
		await Promise.resolve();
		harness.snapshots.length = 0;

		info = { docId: 'other.md', mode: 'live', language: 'markdown' };
		harness.view.dispatch({ selection: { anchor: 1 } });
		const snapshot = last(harness.snapshots);
		expect(snapshot.trigger).toBe('file-open');
		expect(snapshot.docId).toBe('other.md');
		expect(snapshot.mode).toBe('live');
	});

	it('falls back to safe defaults when getDocInfo throws', async () => {
		const harness = mount('abc', {
			info: () => {
				throw new Error('boom');
			},
		});
		await Promise.resolve();
		const snapshot = last(harness.snapshots);
		expect(snapshot.docId).toBe('');
		expect(snapshot.mode).toBe('source');
		expect(snapshot.language).toBeNull();
	});

	it('calls onDestroy once when the view is destroyed', async () => {
		const harness = mount('abc');
		await Promise.resolve();
		harness.view.destroy();
		expect(harness.destroyCount()).toBe(1);
	});
});
