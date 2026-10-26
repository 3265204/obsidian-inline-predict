/** 对短中文上下文做低成本词面相关性检查。仅用于标记可疑的长建议，不替代语义理解。 */

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const LATIN_WORD_RE = /[a-z][a-z0-9_'-]{2,}/g;
const NUMBER_RE = /\d{2,}/g;

export interface RelatednessTokens {
	cjkBigrams: Set<string>;
	latinWords: Set<string>;
	numbers: Set<string>;
	cjkChars: number;
}

/** Tokenize for overlap. CJK uses character bigrams (no dictionary dependency). */
export function tokenizeRelatedness(text: string): RelatednessTokens {
	const cjkBigrams = new Set<string>();
	const latinWords = new Set<string>();
	const numbers = new Set<string>();
	let cjkChars = 0;
	const normalized = text.normalize('NFKC');
	let cjkRun: string[] = [];
	const flushRun = (): void => {
		for (let i = 0; i + 1 < cjkRun.length; i++) {
			cjkBigrams.add(`${cjkRun[i]}${cjkRun[i + 1]}`);
		}
		cjkRun = [];
	};
	for (const ch of normalized) {
		if (CJK_CHAR_RE.test(ch)) {
			cjkRun.push(ch);
			cjkChars++;
		} else {
			flushRun();
		}
	}
	flushRun();
	for (const match of normalized.toLowerCase().matchAll(LATIN_WORD_RE)) latinWords.add(match[0]);
	for (const match of normalized.matchAll(NUMBER_RE)) numbers.add(match[0]);
	return { cjkBigrams, latinWords, numbers, cjkChars };
}

export interface RelatednessAssessment {
	offTopic: boolean;
	/** Shared terms / context terms, in [0, 1]. */
	score: number;
	contextTerms: number;
	sharedTerms: number;
	/** True when the heuristic was even applicable (CJK-dominant short context + long output). */
	assessed: boolean;
}

export interface OffTopicOptions {
	/** Only candidates at least this long (code units) can be flagged. Default 20. */
	minCandidateChars?: number;
	/** Context is taken from the tail of the document; only contexts up to this length are judged. */
	maxContextChars?: number;
	/** Minimum CJK character share for the heuristic to apply. */
	minCjkRatio?: number;
	/** Minimum number of context terms required. */
	minContextTerms?: number;
}

const DEFAULTS: Required<OffTopicOptions> = {
	minCandidateChars: 20,
	maxContextChars: 160,
	minCjkRatio: 0.3,
	minContextTerms: 2,
};

/**
 * Conservative off-topic detection. Returns `assessed: false` when the heuristic does not apply,
 * in which case the caller must not reject the candidate.
 */
export function assessOffTopic(
	contextText: string,
	candidateText: string,
	options: OffTopicOptions = {},
): RelatednessAssessment {
	const config = { ...DEFAULTS, ...options };
	const context = contextText.trim();
	const candidate = candidateText.trim();
	// A long note has enough context elsewhere; judging only the tail would be misleading.
	if (context.length > config.maxContextChars) {
		return { offTopic: false, score: 0, contextTerms: 0, sharedTerms: 0, assessed: false };
	}
	const tokens = tokenizeRelatedness(context);
	const contextTerms = tokens.cjkBigrams.size + tokens.latinWords.size + tokens.numbers.size;
	const contextChars = Array.from(context).length;
	const cjkRatio = tokens.cjkChars / Math.max(1, contextChars);

	const applicable =
		candidate.length >= config.minCandidateChars &&
		context.length > 0 &&
		context.length <= config.maxContextChars &&
		cjkRatio >= config.minCjkRatio &&
		contextTerms >= config.minContextTerms;

	if (!applicable) {
		return { offTopic: false, score: 0, contextTerms, sharedTerms: 0, assessed: false };
	}

	const candidateTokens = tokenizeRelatedness(candidate);
	let sharedTerms = 0;
	for (const bigram of tokens.cjkBigrams) {
		if (candidate.includes(bigram)) sharedTerms++;
	}
	for (const word of tokens.latinWords) {
		if (candidateTokens.latinWords.has(word)) sharedTerms++;
	}
	for (const number of tokens.numbers) {
		if (candidateTokens.numbers.has(number)) sharedTerms++;
	}

	return {
		offTopic: sharedTerms === 0,
		score: contextTerms === 0 ? 0 : sharedTerms / contextTerms,
		contextTerms,
		sharedTerms,
		assessed: true,
	};
}

/** 前文词面不重合时，后文也能为中间插入提供依据，避免无谓的模型复核。 */
export function assessInsertionOffTopic(
	before: string,
	after: string,
	candidate: string,
): RelatednessAssessment {
	const assessment = assessOffTopic(before.trim().length > 0 ? before : after, candidate);
	if (!assessment.offTopic || before.trim().length === 0 || after.trim().length === 0) {
		return assessment;
	}
	// 只查看紧邻光标的后文，不让远处无关段落的偶然重词影响判断。
	const lookahead = assessOffTopic(after.trimStart().slice(0, DEFAULTS.maxContextChars), candidate, {
		minCjkRatio: 0,
		minContextTerms: 1,
	});
	return lookahead.sharedTerms > 0 ? lookahead : assessment;
}
