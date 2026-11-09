import { animationClock, MOTION } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolHeader } from "../../src/octocode/render/tool.ts";
import { stopRowTimers } from "../../src/octocode/render/rows.ts";
import { stopRowMotion } from "../../src/octocode/render/motion.ts";
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
	stopRowMotion();
	animationClock.setReducedMotion(false);
});

describe("parallel tool rows", () => {
	it("do not flash an older row that finishes after a newer one: its frames would clear the scrollback", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const older = row();
		const newer = row();
		toolHeader(theme, older, "Bash", "sleep 10");
		toolHeader(theme, newer, "Bash", "seq 1 60");
		vi.advanceTimersByTime(MOTION.spinnerMs * 3);
		const newerDone = { ...newer, isPartial: false, durationMs: 5 };
		toolHeader(theme, newerDone, "Bash", "seq 1 60");
		vi.advanceTimersByTime(MOTION.flashMs + MOTION.glowFrameMs);
		toolHeader(theme, newerDone, "Bash", "seq 1 60");
		vi.advanceTimersByTime(MOTION.spinnerMs * 100);
		const before = older.invalidate.mock.calls.length;
		const olderDone = { ...older, isPartial: false, durationMs: 10_000 };
		const first = rendered(toolHeader(theme, olderDone, "Bash", "sleep 10"))[0];
		vi.advanceTimersByTime(MOTION.flashMs * 2);
		// Settled on its first finished frame: no frame after it, no subscription on the clock.
		expect(rendered(toolHeader(theme, olderDone, "Bash", "sleep 10"))[0]).toBe(first);
		expect(older.invalidate.mock.calls.length).toBe(before);
		expect(animationClock.isRunning()).toBe(false);
	});

	it("still flash a single row that finishes after it visibly ran", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const only = row();
		toolHeader(theme, only, "Bash", "ls");
		vi.advanceTimersByTime(MOTION.spinnerMs);
		toolHeader(theme, { ...only, isPartial: false, durationMs: 5 }, "Bash", "ls");
		expect(animationClock.isRunning()).toBe(true);
	});
});
