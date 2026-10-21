/**
 * Cheap Markdown structure analysis over the text before the cursor.
 *
 * The observer already hands us a capped prefix; this module does a single forward pass and
 * never touches the document or CodeMirror syntax tree. It deliberately re-implements just
 * enough CommonMark (ATX headings, fenced code, `$$` math parity, list markers) to place the
 * cursor structurally, because pulling in a parser on every keystroke would be wasteful.
 */

export interface MarkdownStructure {
	headingPath: string[];
	currentHeading: string | null;
	paragraphIndex: number;
	paragraphText: string;
	lineText: string;
	listContext: 'none' | 'bullet' | 'ordered' | 'task';
	fenceLanguage: string | null;
	inCodeBlock: boolean;
	inMathBlock: boolean;
	documentTitle: string | null;
}

const ATX_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}([`~]{3,})[ \t]*$/;
const BLANK_RE = /^[ \t]*$/;
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]*)*/;
const TASK_ITEM_RE = /^[-*+][ \t]+\[[ xX]\][ \t]+/;
const BULLET_ITEM_RE = /^[-*+][ \t]+/;
const ORDERED_ITEM_RE = /^\d{1,9}[.)][ \t]+/;

function stripCarriageReturn(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function countDoubleDollars(line: string): number {
	let count = 0;
	let index = line.indexOf('$$');
	while (index !== -1) {
		count++;
		index = line.indexOf('$$', index + 2);
	}
	return count;
}

function isFenceClose(line: string, marker: string): boolean {
	const match = FENCE_CLOSE_RE.exec(line);
	if (!match) return false;
	const run = match[1] ?? '';
	const char = marker.charAt(0);
	return run.charAt(0) === char && run.length >= marker.length;
}

function detectListContext(lineText: string): MarkdownStructure['listContext'] {
	const content = lineText.replace(BLOCKQUOTE_PREFIX_RE, '');
	if (TASK_ITEM_RE.test(content)) return 'task';
	if (ORDERED_ITEM_RE.test(content)) return 'ordered';
	if (BULLET_ITEM_RE.test(content)) return 'bullet';
	return 'none';
}

function cleanHeadingText(raw: string): string {
	// Trailing `###` sequences are optional closing syntax in ATX headings.
	return raw.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/** Title fallback for untitled buffers: the vault path basename, without `.md`. */
function titleFromDocId(docId: string): string | null {
	const trimmed = docId.trim();
	if (trimmed.length === 0) return null;
	const segments = trimmed.split('/');
	const name = segments[segments.length - 1] ?? '';
	const withoutExtension = name.endsWith('.md') ? name.slice(0, -3) : name;
	const title = withoutExtension.trim();
	return title.length > 0 ? title : null;
}

export function analyzeMarkdownBeforeCursor(prefix: string, docId: string): MarkdownStructure {
	const lines = prefix.split('\n');
	const headingStack: string[] = [];
	let headingPath: string[] = [];
	let currentHeading: string | null = null;
	let firstH1: string | null = null;
	let inCodeBlock = false;
	let fenceMarker = '';
	let fenceLanguage: string | null = null;
	let mathDelimiterCount = 0;
	let paragraphIndex = 0;
	let currentParagraph: string[] = [];
	let lineText = '';

	for (let i = 0; i < lines.length; i++) {
		const line = stripCarriageReturn(lines[i] ?? '');
		if (i === lines.length - 1) lineText = line;

		if (inCodeBlock) {
			if (isFenceClose(line, fenceMarker)) {
				inCodeBlock = false;
				fenceMarker = '';
				fenceLanguage = null;
			}
			if (BLANK_RE.test(line)) {
				if (currentParagraph.length > 0) {
					paragraphIndex++;
					currentParagraph = [];
				}
			} else {
				currentParagraph.push(line);
			}
			continue;
		}

		const fenceOpen = FENCE_OPEN_RE.exec(line);
		if (fenceOpen) {
			const marker = fenceOpen[1] ?? '```';
			const info = (fenceOpen[2] ?? '').trim();
			inCodeBlock = true;
			fenceMarker = marker;
			fenceLanguage = info.length > 0 ? (info.split(/\s+/)[0] ?? null) : null;
			currentParagraph.push(line);
			continue;
		}

		mathDelimiterCount += countDoubleDollars(line);

		const heading = ATX_HEADING_RE.exec(line);
		if (heading) {
			const level = (heading[1] ?? '#').length;
			const title = cleanHeadingText(heading[2] ?? '');
			if (title.length > 0) {
				while (headingStack.length >= level) headingStack.pop();
				headingStack.push(title);
				headingPath = [...headingStack];
				currentHeading = title;
				if (level === 1 && firstH1 === null) firstH1 = title;
			}
			currentParagraph.push(line);
			continue;
		}

		if (BLANK_RE.test(line)) {
			if (currentParagraph.length > 0) {
				paragraphIndex++;
				currentParagraph = [];
			}
			continue;
		}
		currentParagraph.push(line);
	}

	const paragraphText = currentParagraph.join('\n').replace(/[ \t\r]+$/, '');
	const title = titleFromDocId(docId) ?? firstH1;

	return {
		headingPath,
		currentHeading,
		paragraphIndex,
		paragraphText,
		lineText,
		listContext: inCodeBlock ? 'none' : detectListContext(lineText),
		fenceLanguage,
		inCodeBlock,
		inMathBlock: mathDelimiterCount % 2 === 1,
		documentTitle: title,
	};
}
