import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCtrlZ } from "../../src/modes/interactive/interactive-mode/lifecycle.ts";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../../src/utils/shell.ts";
import { createFakeHost } from "../interactive-mode-host.ts";

describe("suspending with Ctrl+Z", () => {
	afterEach(() => vi.restoreAllMocks());

	it("stops the running children's process groups first and continues them on resume", () => {
		trackDetachedChildPid(424242);
		const kills: Array<[number, unknown]> = [];
		vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string) => {
			kills.push([pid, signal]);
			return true;
		}) as typeof process.kill);
		let resume: (() => void) | undefined;
		vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") resume = listener;
			return process;
		}) as typeof process.once);
		vi.spyOn(process, "on").mockImplementation((() => process) as typeof process.on);
		vi.spyOn(process, "removeListener").mockImplementation((() => process) as typeof process.removeListener);
		vi.spyOn(globalThis, "setInterval").mockReturnValue(setTimeout(() => undefined, 0));
		vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const ui = { start: vi.fn(), stop: vi.fn(), requestRender: vi.fn() };
		try {
			handleCtrlZ(createFakeHost({ ui }));
			expect(kills).toEqual([
				[-424242, "SIGSTOP"],
				[0, "SIGTSTP"],
			]);
			kills.length = 0;
			resume?.();
			expect(kills).toEqual([[-424242, "SIGCONT"]]);
			expect(ui.start).toHaveBeenCalledTimes(1);
		} finally {
			untrackDetachedChildPid(424242);
		}
	});
});
