import type { BuiltContext, ChatMessage, ChatTokenCounter } from '../core/types';
import { BUDGET_SAFETY_MARGIN_TOKENS, SECTION_PRIORITY, truncateTextToTokens } from '../tokens/budget';
import { buildPromptMessages } from './prompt-builder';

/** 最终预算按完整消息计算，包含系统提示、消息封装和分隔标签。 */
export function buildBudgetedPrompt(
	context: BuiltContext,
	windowTokens: number,
	outputTokens: number,
	counter: ChatTokenCounter,
): ChatMessage[] | null {
	const ceiling = Math.min(windowTokens, context.report.budget.windowTokens) -
		outputTokens - BUDGET_SAFETY_MARGIN_TOKENS;
	let sections = context.sections.filter((section) => section.id !== 'rules');
	let messages = buildPromptMessages({ ...context, sections });
	while (counter.countMessages(messages) > ceiling) {
		const id = [...SECTION_PRIORITY].reverse().find((key) => sections.some((s) => s.id === key));
		if (id === undefined) return null;
		const index = sections.findIndex((section) => section.id === id);
		const section = sections[index];
		if (!section) return null;
		const excess = counter.countMessages(messages) - ceiling;
		const allowance = Math.max(0, counter.count(section.text) - Math.max(1, excess));
		const text = truncateTextToTokens(section.text, allowance, counter, id === 'before' ? 'tail' : 'head');
		sections = sections.filter((_, i) => i !== index);
		if (text.length > 0) sections.push({ ...section, text, truncated: true });
		messages = buildPromptMessages({ ...context, sections });
	}
	// 原有前文完全放不下时跳过预测，避免在缺乏依据的情况下生成。
	if (context.snapshot.prefix.length > 0 && !sections.some((s) => s.id === 'before' && s.text.length > 0)) return null;
	// 中间补全不能退化为盲目续写；后文完全放不下时同样跳过。
	if (context.snapshot.suffix.length > 0 && !sections.some((s) => s.id === 'after' && s.text.length > 0)) return null;
	return messages;
}
