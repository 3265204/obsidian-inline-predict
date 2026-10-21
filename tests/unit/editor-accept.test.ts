// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { applyAccept, sliceForAccept } from '../../src/editor/accept';
import type { ActiveSuggestion } from '../../src/core/types';

const openViews: EditorView[] = [];

function openView(doc: string, cursor = doc.length): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const view = new EditorView({
		state: EditorState.create({ doc, selection: { anchor: cursor } }),
		parent,
	});
	openViews.push(view);
	return view;
}

function suggestion(remainingText: string, anchor: number): ActiveSuggestion {
	return {
		candidate: {
			requestId: 7,
			text: remainingText,
			docId: 'note.md',
			docVersion: 3,
			anchor,
			finishReason: 'stop',
			usage: null,
			modelId: 'test-model',
			createdAt: Date.now() - 120,
			latencyMs: 120,
			source: 'model',
			degraded: false,
		},
		remainingText,
		anchor,
		docVersion: 3,
		reusedFromRequestId: null,
	};
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

describe('sliceForAccept', () => {
	it('accepts the next Latin word including its trailing space', () => {
		expect(sliceForAccept('world again', 'word')).toEqual({
			accepted: 'world ',
			remaining: 'again',
		});
	});

	it('keeps leading whitespace with the following word', () => {
		expect(sliceForAccept(' world again', 'word')).toEqual({
			accepted: ' world ',
			remaining: 'again',
		});
	});

	it('accepts one CJK code point at a time', () => {
		expect(sliceForAccept('你好世界', 'word')).toEqual({ accepted: '你', remaining: '好世界' });
	});

	it('never splits an emoji surrogate pair', () => {
		const slice = sliceForAccept('😀abc', 'word');
		expect(slice.accepted).toBe('😀');
		expect(slice.remaining).toBe('abc');

		const sentence = sliceForAccept('hi 😀. next', 'sentence');
		expect(sentence.accepted).toBe('hi 😀. ');
		expect(sentence.remaining).toBe('next');
	});

	it('accepts the next sentence for Latin and CJK text', () => {
		expect(sliceForAccept('Hello world. Next one!', 'sentence')).toEqual({
			accepted: 'Hello world. ',
			remaining: 'Next one!',
		});
		expect(sliceForAccept('你好。世界！', 'sentence')).toEqual({
			accepted: '你好。',
			remaining: '世界！',
		});
	});

	it('accepts through the end of a line including LF and CRLF', () => {
		expect(sliceForAccept('line one\nline two', 'line')).toEqual({
			accepted: 'line one\n',
			remaining: 'line two',
		});
		expect(sliceForAccept('line one\r\nline two', 'line')).toEqual({
			accepted: 'line one\r\n',
			remaining: 'line two',
		});
	});

	it('accepts through a paragraph break including CRLF separators', () => {
		expect(sliceForAccept('p1\n\np2', 'paragraph')).toEqual({
			accepted: 'p1\n\n',
			remaining: 'p2',
		});
		expect(sliceForAccept('p1\r\n\r\np2', 'paragraph')).toEqual({
			accepted: 'p1\r\n\r\n',
			remaining: 'p2',
		});
		expect(sliceForAccept('第一段😀\n\n第二段', 'paragraph')).toEqual({
			accepted: '第一段😀\n\n',
			remaining: '第二段',
		});
	});

	it('returns the whole text when it is the last line/paragraph', () => {
		expect(sliceForAccept('only line', 'line')).toEqual({
			accepted: 'only line',
			remaining: '',
		});
		expect(sliceForAccept('only para', 'paragraph')).toEqual({
			accepted: 'only para',
			remaining: '',
		});
	});

	it('always makes progress at a leading delimiter', () => {
		expect(sliceForAccept('\nnext line', 'line')).toEqual({
			accepted: '\n',
			remaining: 'next line',
		});
		expect(sliceForAccept('\n\nnext para', 'paragraph')).toEqual({
			accepted: '\n\n',
			remaining: 'next para',
		});
	});

	it('handles empty text', () => {
		expect(sliceForAccept('', 'word')).toEqual({ accepted: '', remaining: '' });
		expect(sliceForAccept('', 'paragraph')).toEqual({ accepted: '', remaining: '' });
	});
});

describe('applyAccept', () => {
	it('inserts the accepted text and moves the cursor after it', () => {
		const view = openView('Hello', 5);
		const result = applyAccept(view, suggestion(' world again', 5), 'word');
		expect(result).toEqual({ accepted: ' world ', remaining: 'again' });
		expect(view.state.doc.toString()).toBe('Hello world ');
		expect(view.state.selection.main.head).toBe(12);
	});

	it('accepts everything for "all" and reports no remainder', () => {
		const view = openView('Hello', 5);
		const result = applyAccept(view, suggestion(' world', 5), 'all');
		expect(result).toEqual({ accepted: ' world', remaining: null });
		expect(view.state.doc.toString()).toBe('Hello world');
		expect(view.state.selection.main.head).toBe(11);
	});

	it('inserts a multi-line remainder literally (Markdown preserved)', () => {
		const view = openView('Intro', 5);
		const text = '\n- item one\n- item two';
		const result = applyAccept(view, suggestion(text, 5), 'all');
		expect(result.accepted).toBe(text);
		expect(view.state.doc.toString()).toBe('Intro' + text);
		expect(view.state.selection.main.head).toBe(5 + text.length);
	});

	it('never splits an emoji surrogate pair when inserting', () => {
		const view = openView('', 0);
		const result = applyAccept(view, suggestion('😀 tail', 0), 'word');
		expect(result.accepted).toBe('😀');
		const doc = view.state.doc.toString();
		expect(doc).toBe('😀');
		expect(doc.codePointAt(0)).toBe(0x1f600);
	});

	it('clamps an out-of-range anchor instead of throwing', () => {
		const view = openView('ab', 2);
		const result = applyAccept(view, suggestion('x', 50), 'all');
		expect(result.accepted).toBe('x');
		expect(view.state.doc.toString()).toBe('abx');
		expect(view.state.selection.main.head).toBe(3);
	});

	it('does nothing for an empty suggestion', () => {
		const view = openView('hello', 5);
		const result = applyAccept(view, suggestion('', 5), 'all');
		expect(result).toEqual({ accepted: '', remaining: null });
		expect(view.state.doc.toString()).toBe('hello');
	});
});
