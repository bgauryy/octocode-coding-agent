import { animationClock, MOTION } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolHeader } from "../../src/octocode/render/tool.ts";
import { stopRowTimers } from "../../src/octocode/render/rows.ts";
import type { ToolRow } from "../../src/octocode/render/types.ts";
import { rendered, theme } from "./fake-host.ts";

const row = () => ({
	state: {} as ToolRow,
	invalidate: vi.fn(),
	executionStarted: true,
	isPartial: true,
	isError: false,
	expanded: false,
});

beforeEach(() => animationClock.setReducedMotion(false));
afterEach(() => {
	vi.useRealTimers();
	stopRowTimers();
	animationClock.setReducedMotion(false);
});

describe("parallel tool rows", () => {
	it("stop repainting the moment each finishes, in any order, leaving the clock idle", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const older = row();
		const newer = row();
		toolHeader(theme, older, "Bash", "sleep 10");
		toolHeader(theme, newer, "Bash", "seq 1 60");
		// A running row repaints once a second, for its elapsed time.
		vi.advanceTimersByTime(MOTION.tickMs * 3);
		expect(older.invalidate).toHaveBeenCalledTimes(3);
		expect(newer.invalidate).toHaveBeenCalledTimes(3);
		const newerDone = { ...newer, isPartial: false, durationMs: 5 };
		toolHeader(theme, newerDone, "Bash", "seq 1 60");
		const newerCalls = newer.invalidate.mock.calls.length;
		vi.advanceTimersByTime(MOTION.tickMs * 20);
		expect(newer.invalidate.mock.calls.length).toBe(newerCalls);
		expect(older.invalidate).toHaveBeenCalledTimes(23);
		const olderDone = { ...older, isPartial: false, durationMs: 10_000 };
		const first = rendered(toolHeader(theme, olderDone, "Bash", "sleep 10"))[0];
		const olderCalls = older.invalidate.mock.calls.length;
		vi.advanceTimersByTime(MOTION.tickMs * 20);
		expect(rendered(toolHeader(theme, olderDone, "Bash", "sleep 10"))[0]).toBe(first);
		expect(older.invalidate.mock.calls.length).toBe(olderCalls);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("does not subscribe a row that first draws finished", () => {
		vi.useFakeTimers();
		const only = { ...row(), isPartial: false, durationMs: 5 };
		toolHeader(theme, only, "Bash", "ls");
		expect(animationClock.isRunning()).toBe(false);
	});
});
