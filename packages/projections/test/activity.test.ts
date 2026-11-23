import type { ApplicationPhase } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { activity, type ActivityFacts } from "../src/index.ts";

const tone = (facts: ActivityFacts | undefined) => activity(facts).tone;

describe("activity", () => {
	it("is idle with no facts, and idle after a run that ended well", () => {
		expect(activity(undefined)).toEqual({ tone: "idle", state: "pending", label: "idle" });
		expect(activity({ streaming: false, phase: { state: "done" } })).toEqual({
			tone: "idle",
			state: "pending",
			label: "done",
		});
	});

	it("is working while a run streams, compacts, retries or the model is quiet, and says which", () => {
		expect(activity({ streaming: true })).toEqual({ tone: "working", state: "running", label: "working" });
		expect(activity({ status: "compacting" }).label).toBe("compacting");
		expect(activity({ status: "retrying" })).toEqual({ tone: "working", state: "running", label: "retrying" });
		expect(activity({ streaming: true, status: "stalled" }).label).toBe("not answering");
		expect(tone({ phase: { state: "working", activity: "Running bash" } })).toBe("working");
	});

	it("is waiting whenever a dialog waits for the user, over a run and over a failure", () => {
		expect(activity({ streaming: true, awaiting: { kind: "approval", title: "Run bash?" } })).toEqual({
			tone: "waiting",
			state: "waiting",
			label: "needs you",
		});
		// A session list knows only that a dialog is open.
		expect(tone({ awaiting: true })).toBe("waiting");
		expect(tone({ phase: { state: "blocked", title: "Continue after the usage limit?" } })).toBe("waiting");
		expect(tone({ awaiting: true, phase: { state: "failed", error: "x" } })).toBe("waiting");
		expect(tone({ awaiting: false, streaming: true })).toBe("working");
	});

	it("reads the phase once no run is active: background work and wakes work, timers idle, failures and stops are errors", () => {
		const cases: Array<[ApplicationPhase, string, string]> = [
			[{ state: "waiting", agents: 2, queued: 0, bash: 0, external: 0 }, "working", "background"],
			[{ state: "resuming", label: "report" }, "working", "resuming"],
			[{ state: "scheduled", timers: 1, id: "t1" }, "idle", "scheduled"],
			[{ state: "failed", error: "401" }, "error", "failed"],
			[{ state: "stopped", open: ["B1"] }, "error", "stopped"],
			[{ state: "idle" }, "idle", "idle"],
		];
		for (const [phase, expected, label] of cases) {
			expect(activity({ streaming: false, phase }), phase.state).toMatchObject({ tone: expected, label });
		}
	});

	it("draws each tone with a distinct state, so no light rests on colour alone", () => {
		const states = (["working", "waiting", "error", "idle"] as const).map(
			(expected) =>
				[
					activity({ streaming: true }),
					activity({ awaiting: true }),
					activity({ phase: { state: "failed", error: "x" } }),
					activity({}),
				].find((each) => each.tone === expected)?.state,
		);
		expect(states).toEqual(["running", "waiting", "failed", "pending"]);
	});
});
