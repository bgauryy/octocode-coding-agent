import { animationClock, MOTION } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolHeader } from "../../src/octocode/render/tool.ts";
import { stopRowTimers } from "../../src/octocode/render/rows.ts";
import type { ToolRow } from "../../src/octocode/render/types.ts";
import { rendered, theme } from "./fake-host.ts";

beforeEach(() => animationClock.setReducedMotion(false));
afterEach(() => {
	vi.useRealTimers();
	stopRowTimers();
	animationClock.setReducedMotion(false);
});

describe("running tool row cadence", () => {
	it("repaints a running row only on its one-second elapsed tick, never at spinner pace", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const invalidate = vi.fn();
		const context = {
			state: {} as ToolRow,
			invalidate,
			executionStarted: true,
			isPartial: true,
			isError: false,
			expanded: false,
		};
		const draw = () => rendered(toolHeader(theme, context, "Bash", "sleep 10"));
		expect(draw()).toBe("⏺ Bash(sleep 10) · 0ms");
		// The row holds no animation subscription: the clock runs for its elapsed counter alone, once a second.
		expect(animationClock.isRunning()).toBe(true);
		for (let frame = 1; frame < MOTION.tickMs / MOTION.spinnerMs; frame++) {
			vi.advanceTimersByTime(MOTION.spinnerMs);
			expect(invalidate).not.toHaveBeenCalled();
			expect(draw()[0]).toBe("⏺");
		}
		vi.advanceTimersByTime(MOTION.spinnerMs);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(draw()).toBe("⏺ Bash(sleep 10) · 1s");
		vi.advanceTimersByTime(MOTION.tickMs * 9);
		expect(invalidate).toHaveBeenCalledTimes(10);
		expect(draw()).toBe("⏺ Bash(sleep 10) · 10s");
		stopRowTimers();
		expect(animationClock.isRunning()).toBe(false);
	});
});
