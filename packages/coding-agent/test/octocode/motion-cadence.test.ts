import { animationClock, MOTION } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolHeader } from "../../src/octocode/render/tool.ts";
import { stopRowTimers } from "../../src/octocode/render/rows.ts";
import { stopRowMotion } from "../../src/octocode/render/motion.ts";
import type { ToolRow } from "../../src/octocode/render/types.ts";
import { theme } from "./fake-host.ts";

beforeEach(() => animationClock.setReducedMotion(false));
afterEach(() => {
	vi.useRealTimers();
	stopRowTimers();
	stopRowMotion();
	animationClock.setReducedMotion(false);
});

describe("running tool row cadence", () => {
	it("repaints a foreground row every spinner frame", () => {
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
		toolHeader(theme, context, "Bash", "sleep 10");
		vi.advanceTimersByTime(MOTION.spinnerMs * 10);
		expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(9);
	});
});
