import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextSection, EditorSnapshot } from '../../src/core/types';
import { CONTEXT_CACHE_TTL_MS } from '../../src/core/constants';
import { analyzeMarkdownBeforeCursor } from '../../src/context/markdown-structure';
import { ContextEngine, type ContextEngineDeps } from '../../src/context/context-engine';

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
	return {
		docId: 'Notes/test.md',
		docVersion: 1,
		cursor: 0,
		selectionFrom: 0,
		selectionTo: 0,
		prefix: '',
		prefixOffset: 0,
		suffix: '',
		line: 0,
		ch: 0,
		lineTextBefore: '',
		lineTextAfter: '',
		isComposing: false,
		timestamp: 0,
		trigger: 'doc-change',
		lastEdit: null,
		language: 'markdown',
		mode: 'source',
		inCodeBlock: false,
		inMathBlock: false,
		...overrides,
	};
}

function makeDeps(overrides: Partial<ContextEngineDeps> = {}): ContextEngineDeps {
	return { modelContextWindow: 8_192, maxOutputTokens: 256, ...overrides };
}

function knowledgeSection(text = 'Retrieved note content.'): ContextSection {
	return {
		id: 'knowledge',
		label: 'chunk',
		trust: 'retrieved',
		text,
		estimatedTokens: 4,
	};
}

function makeRetrieval(snippets: readonly string[] = ['Retrieved note content.']) {
	const queries: string[] = [];
	const retrieval = {
		async search(query: string): Promise<readonly ContextSection[]> {
			queries.push(query);
			return snippets.map((text) => knowledgeSection(text));
		},
	};
	return { retrieval, queries };
}

/* ------------------------------------------------------------------ */
/* Markdown structure                                                  */
/* ------------------------------------------------------------------ */

describe('analyzeMarkdownBeforeCursor', () => {
	it('tracks the heading path, current heading and document title', () => {
		const structure = analyzeMarkdownBeforeCursor(
			'# Project\n\n## Design\n\nSome prose here',
			'Notes/My Note.md',
		);
		expect(structure.headingPath).toEqual(['Project', 'Design']);
		expect(structure.currentHeading).toBe('Design');
		expect(structure.documentTitle).toBe('My Note');
		expect(structure.lineText).toBe('Some prose here');
		expect(structure.paragraphText).toBe('Some prose here');
		expect(structure.paragraphIndex).toBe(2);
	});

	it('falls back to the first H1 when the document has no path', () => {
		const structure = analyzeMarkdownBeforeCursor('# Real Title\n\nbody', '');
		expect(structure.documentTitle).toBe('Real Title');
		expect(structure.headingPath).toEqual(['Real Title']);
	});

	it('strips trailing hashes from ATX headings', () => {
		const structure = analyzeMarkdownBeforeCursor('## Title ##\ntext', 'a.md');
		expect(structure.currentHeading).toBe('Title');
	});

	it('detects bullet, ordered and task list contexts', () => {
		expect(analyzeMarkdownBeforeCursor('- first item\n- sec', 'a.md').listContext).toBe('bullet');
		expect(analyzeMarkdownBeforeCursor('  * nested', 'a.md').listContext).toBe('bullet');
		expect(analyzeMarkdownBeforeCursor('> - quoted', 'a.md').listContext).toBe('bullet');
		expect(analyzeMarkdownBeforeCursor('1. first', 'a.md').listContext).toBe('ordered');
		expect(analyzeMarkdownBeforeCursor('- [ ] todo', 'a.md').listContext).toBe('task');
		expect(analyzeMarkdownBeforeCursor('- [x] done', 'a.md').listContext).toBe('task');
		expect(analyzeMarkdownBeforeCursor('plain text', 'a.md').listContext).toBe('none');
	});

	it('tracks fenced code blocks and their language', () => {
		const open = analyzeMarkdownBeforeCursor('```js\nconst x = 1;', 'a.md');
		expect(open.inCodeBlock).toBe(true);
		expect(open.fenceLanguage).toBe('js');
		expect(open.listContext).toBe('none');

		const closed = analyzeMarkdownBeforeCursor('```\ncode\n```\nafter', 'a.md');
		expect(closed.inCodeBlock).toBe(false);

		const tilde = analyzeMarkdownBeforeCursor('~~~python\nx = 1', 'a.md');
		expect(tilde.inCodeBlock).toBe(true);
		expect(tilde.fenceLanguage).toBe('python');
	});

	it('ignores headings and math delimiters inside fenced code', () => {
		const structure = analyzeMarkdownBeforeCursor(
			'# Real\n```\n# not a heading\n$$\n```\n',
			'a.md',
		);
		expect(structure.headingPath).toEqual(['Real']);
		expect(structure.inMathBlock).toBe(false);
	});

	it('tracks $$ math block parity outside code', () => {
		expect(analyzeMarkdownBeforeCursor('$$\nx = 1\n', 'a.md').inMathBlock).toBe(true);
		expect(analyzeMarkdownBeforeCursor('$$\nx = 1\n$$\n', 'a.md').inMathBlock).toBe(false);
		expect(analyzeMarkdownBeforeCursor('text $$inline$$ text', 'a.md').inMathBlock).toBe(false);
	});
});

/* ------------------------------------------------------------------ */
/* Context engine                                                      */
/* ------------------------------------------------------------------ */

describe('ContextEngine', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('always builds the hot sections with the right trust levels', async () => {
		const engine = new ContextEngine(makeDeps());
		const snapshot = makeSnapshot({
			docId: 'Notes/My Note.md',
			prefix: '# Title\n\nHello world',
			suffix: ' and then some',
		});
		const built = await engine.build(snapshot, new AbortController().signal);

		const byId = new Map(built.sections.map((section) => [section.id, section]));
		expect([...byId.keys()]).toEqual(
			expect.arrayContaining(['rules', 'structure', 'before', 'after']),
		);
		expect(byId.get('rules')?.trust).toBe('system');
		expect(byId.get('structure')?.trust).toBe('document');
		expect(byId.get('before')?.trust).toBe('document');
		expect(byId.get('after')?.trust).toBe('document');
		expect(byId.get('before')?.text).toBe(snapshot.prefix);
		expect(byId.get('after')?.text).toBe(snapshot.suffix);
		const structureText = byId.get('structure')?.text ?? '';
		expect(structureText).toContain('Document title: My Note');
		expect(structureText).toContain('Heading path: Title');
		expect(structureText).toContain('Current heading: Title');
		expect(built.snapshot).toBe(snapshot);
		expect(built.warmKey).not.toBeNull();
		expect(typeof built.createdAt).toBe('number');
	});

	it('omits the after section when there is no suffix', async () => {
		const engine = new ContextEngine(makeDeps());
		const built = await engine.build(
			makeSnapshot({ prefix: 'Hello', suffix: '' }),
			new AbortController().signal,
		);
		expect(built.sections.some((section) => section.id === 'after')).toBe(false);
	});

	it('respects the token budget and reports what was used', async () => {
		const engine = new ContextEngine(makeDeps({ modelContextWindow: 1200, maxOutputTokens: 100 }));
		const snapshot = makeSnapshot({
			prefix: 'word '.repeat(1_000),
			suffix: 'tail '.repeat(500),
		});
		const built = await engine.build(snapshot, new AbortController().signal);

		expect(built.report.budget.windowTokens).toBe(1200);
		expect(built.report.totalInputTokens).toBeLessThanOrEqual(built.report.budget.inputTokens);
		expect(built.sections.some((section) => section.truncated === true)).toBe(true);
		const countedTotal = built.sections.reduce(
			(total, section) => total + section.estimatedTokens,
			0,
		);
		expect(countedTotal).toBe(built.report.totalInputTokens);
	});

	it('keeps the end of the before text when truncating', async () => {
		const engine = new ContextEngine(makeDeps({ modelContextWindow: 1200, maxOutputTokens: 100 }));
		const prefix = `${'filler '.repeat(300)}NEAREST-CURSOR-TEXT`;
		const built = await engine.build(makeSnapshot({ prefix }), new AbortController().signal);
		const before = built.sections.find((section) => section.id === 'before');
		expect(before?.text.endsWith('NEAREST-CURSOR-TEXT')).toBe(true);
		expect(before?.truncated).toBe(true);
	});

	it('reuses warm context for the same document section', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const snapshot = makeSnapshot({ prefix: '# Heading\n\nsome text ' });

		const first = await engine.build(snapshot, new AbortController().signal);
		const second = await engine.build(snapshot, new AbortController().signal);

		expect(queries).toHaveLength(1);
		expect(second.warmKey).toBe(first.warmKey);
		const knowledge = second.sections.find((section) => section.id === 'knowledge');
		expect(knowledge?.trust).toBe('retrieved');
		expect(knowledge?.text).toContain('Retrieved note content.');
		expect(queries[0]).toContain('Heading');
	});

	it('invalidates warm context when the heading changes', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));

		await engine.build(
			makeSnapshot({ prefix: '# First\n\nbody ' }),
			new AbortController().signal,
		);
		await engine.build(
			makeSnapshot({ prefix: '# Second\n\nbody ' }),
			new AbortController().signal,
		);

		expect(queries).toHaveLength(2);
	});

	it('invalidates warm context when the file changes', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));

		await engine.build(
			makeSnapshot({ docId: 'Notes/a.md', prefix: 'same text ' }),
			new AbortController().signal,
		);
		await engine.build(
			makeSnapshot({ docId: 'Notes/b.md', prefix: 'same text ' }),
			new AbortController().signal,
		);

		expect(queries).toHaveLength(2);
	});

	it('invalidates warm context when the profile version changes', async () => {
		const { retrieval, queries } = makeRetrieval();
		const profile = { version: 'v1', getText: () => 'Writes terse notes.' };
		const engine = new ContextEngine(makeDeps({ retrieval, profile }));
		const snapshot = makeSnapshot({ prefix: '# Heading\n\nbody ' });

		const first = await engine.build(snapshot, new AbortController().signal);
		profile.version = 'v2';
		const second = await engine.build(snapshot, new AbortController().signal);

		expect(queries).toHaveLength(2);
		expect(second.warmKey).not.toBe(first.warmKey);
		const profileSection = second.sections.find((section) => section.id === 'profile');
		expect(profileSection?.trust).toBe('profile');
		expect(profileSection?.text).toContain('Writes terse notes.');
	});

	it('supports explicit invalidation per document and globally', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const snapshot = makeSnapshot({ docId: 'Notes/a.md', prefix: '# H\n\nbody ' });

		await engine.build(snapshot, new AbortController().signal);
		engine.invalidate('Notes/a.md');
		await engine.build(snapshot, new AbortController().signal);
		expect(queries).toHaveLength(2);

		engine.invalidate();
		await engine.build(snapshot, new AbortController().signal);
		expect(queries).toHaveLength(3);
	});

	it('does not let a failing retrieval break context assembly', async () => {
		let calls = 0;
		const retrieval = {
			async search(): Promise<readonly ContextSection[]> {
				calls++;
				throw new Error('index unavailable');
			},
		};
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const snapshot = makeSnapshot({ prefix: 'body ' });

		const built = await engine.build(snapshot, new AbortController().signal);
		expect(built.sections.some((section) => section.id === 'knowledge')).toBe(false);
		expect(built.sections.some((section) => section.id === 'before')).toBe(true);

		// The failure is cached like a result, so a keystroke does not retry it.
		await engine.build(snapshot, new AbortController().signal);
		expect(calls).toBe(1);
	});

	it('skips retrieval when the request is already aborted', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const controller = new AbortController();
		controller.abort();

		const built = await engine.build(makeSnapshot({ prefix: 'body ' }), controller.signal);
		expect(queries).toHaveLength(0);
		expect(built.sections.some((section) => section.id === 'knowledge')).toBe(false);
		expect(built.sections.some((section) => section.id === 'before')).toBe(true);
	});

	it('omits the profile section when no profile text exists', async () => {
		const absent = new ContextEngine(
			makeDeps({ profile: { version: 'v1', getText: () => null } }),
		);
		const builtAbsent = await absent.build(
			makeSnapshot({ prefix: 'body ' }),
			new AbortController().signal,
		);
		expect(builtAbsent.sections.some((section) => section.id === 'profile')).toBe(false);

		const present = new ContextEngine(
			makeDeps({ profile: { version: 'v1', getText: () => 'Writes long sentences.' } }),
		);
		const builtPresent = await present.build(
			makeSnapshot({ prefix: 'body ' }),
			new AbortController().signal,
		);
		const profile = builtPresent.sections.find((section) => section.id === 'profile');
		expect(profile?.trust).toBe('profile');
		expect(profile?.label).toBe('writing-profile');
	});

	it('bounds the warm cache by entry count', async () => {
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval, warmCacheEntries: 1 }));
		const snapshotFor = (docId: string) => makeSnapshot({ docId, prefix: '# H\n\nbody ' });

		await engine.build(snapshotFor('Notes/a.md'), new AbortController().signal);
		await engine.build(snapshotFor('Notes/b.md'), new AbortController().signal);
		await engine.build(snapshotFor('Notes/a.md'), new AbortController().signal);

		expect(queries).toHaveLength(3);
	});

	it('expires warm context after the TTL', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const snapshot = makeSnapshot({ prefix: '# H\n\nbody ' });

		await engine.build(snapshot, new AbortController().signal);
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z').getTime() + CONTEXT_CACHE_TTL_MS + 1);
		await engine.build(snapshot, new AbortController().signal);

		expect(queries).toHaveLength(2);
	});

	it('does not re-run retrieval for every keystroke within the refresh window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { retrieval, queries } = makeRetrieval();
		const engine = new ContextEngine(makeDeps({ retrieval }));
		const snapshot = makeSnapshot({ prefix: '# H\n\nbody ' });

		await engine.build(snapshot, new AbortController().signal);
		vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
		await engine.build(snapshot, new AbortController().signal);

		expect(queries).toHaveLength(1);
	});
});
