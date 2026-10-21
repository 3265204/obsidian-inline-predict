/** 自动预测只检查可配置的前文长度；临时缓冲区与普通笔记使用同一门槛。 */

import type { EditorSnapshot } from '../core/types';
import type { CompletionSettings } from '../settings/schema';

export function hasSufficientContext(snapshot: EditorSnapshot, settings: CompletionSettings): boolean {
	return snapshot.prefix.trimEnd().length >= Math.max(0, settings.minPrefixChars);
}

/** 手动模式不受自动触发门槛限制；仍向调度器转发最新光标状态。 */
export function shouldDeferAutoRequest(snapshot: EditorSnapshot, settings: CompletionSettings): boolean {
	return settings.autoTrigger && !hasSufficientContext(snapshot, settings);
}
