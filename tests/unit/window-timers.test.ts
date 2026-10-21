import { describe, expect, it, vi } from 'vitest';
import { createWindowTimers } from '../../src/core/timers';

function owner(id: number) {
	return {
		setTimeout: vi.fn<Window['setTimeout']>().mockReturnValue(id),
		clearTimeout: vi.fn<Window['clearTimeout']>(),
	};
}

describe('窗口计时器', () => {
	it('回调和等待时间交给指定窗口', () => {
		const popup = owner(42);
		const callback = vi.fn();
		createWindowTimers(popup).schedule(callback, 8000);
		expect(popup.setTimeout).toHaveBeenCalledWith(callback, 8000);
		expect(callback).not.toHaveBeenCalled();
		const scheduled = popup.setTimeout.mock.calls[0]?.[0];
		if (typeof scheduled === 'function') scheduled();
		expect(callback).toHaveBeenCalledOnce();
	});
	it('不同窗口出现相同句柄时仍在各自窗口取消', () => {
		const main = owner(7);
		const popup = owner(7);
		const cancelMain = createWindowTimers(main).schedule(() => undefined, 400);
		const cancelPopup = createWindowTimers(popup).schedule(() => undefined, 8000);
		cancelPopup();
		expect(popup.clearTimeout).toHaveBeenCalledWith(7);
		expect(main.clearTimeout).not.toHaveBeenCalled();
		cancelMain();
		expect(main.clearTimeout).toHaveBeenCalledWith(7);
	});
});
