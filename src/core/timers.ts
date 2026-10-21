import type { TimerScheduler } from './types';

/** 创建与指定窗口配对的计时器，弹出窗口销毁或切换时仍可正确取消。 */
export function createWindowTimers(owner: Pick<Window, 'setTimeout' | 'clearTimeout'>): TimerScheduler {
	return {
		schedule(callback, delayMs) {
			const id = owner.setTimeout(callback, delayMs);
			return () => owner.clearTimeout(id);
		},
	};
}
