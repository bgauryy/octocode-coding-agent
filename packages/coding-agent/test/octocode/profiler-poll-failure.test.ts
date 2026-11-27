import type { ProfileUpdate } from "@octocodeai/octocode-contracts/profiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfiler, type ProfilerMember, type ProfilerSource } from "../../src/octocode/profiler/service.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A source with one main agent whose status the test changes, and a member list that can fail. */
function source(state: { status: string; fail: boolean; closed?: boolean }): ProfilerSource {
	return {
		sessionId: "s1",
		self: () => ({ id: "main", role: "main", status: state.status }) as ProfilerMember,
		coordinatorFile: () => undefined,
		members: () => {
			if (state.fail) throw new Error("members unreadable");
			return [];
		},
		traffic: () => [],
		transcript: () => undefined,
		...(state.closed === undefined ? {} : { closed: () => state.closed === true }),
	};
}

describe("live profiler updates when a check fails", () => {
	it("reports the failure once and keeps checking, so updates resume", () => {
		vi.useFakeTimers();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const state = { status: "working", fail: false };
		const profiler = createProfiler(source(state));
		const frames: ProfileUpdate[] = [];
		const stop = profiler.subscribe((update) => frames.push(update));
		state.fail = true;
		vi.advanceTimersByTime(3000);
		expect(stderr).toHaveBeenCalledOnce();
		expect(String(stderr.mock.calls[0][0])).toContain("members unreadable");
		state.fail = false;
		state.status = "idle";
		vi.advanceTimersByTime(1000);
		expect(frames.at(-1)?.agent).toMatchObject({ id: "main", status: "idle" });
		stop();
		profiler.close();
	});

	it("stops without a report when the session behind the source has closed", () => {
		vi.useFakeTimers();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const state = { status: "working", fail: false, closed: false };
		const profiler = createProfiler(source(state));
		const frames: ProfileUpdate[] = [];
		profiler.subscribe((update) => frames.push(update));
		state.fail = true;
		state.closed = true;
		vi.advanceTimersByTime(1000);
		state.fail = false;
		state.closed = false;
		state.status = "idle";
		vi.advanceTimersByTime(3000);
		expect(stderr).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		profiler.close();
	});
});
