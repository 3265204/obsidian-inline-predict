import type { TimerScheduler } from '../../src/core/types';

/** 纯逻辑测试使用 Node 假计时器，不依赖浏览器全局对象。 */
export const testTimers: TimerScheduler = {
	schedule(callback, delayMs) {
		const id = setTimeout(callback, delayMs);
		return () => clearTimeout(id);
	},
};
