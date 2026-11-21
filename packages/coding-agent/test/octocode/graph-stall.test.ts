import { describe, expect, it } from "vitest";
import { STALL_MINUTES, StallTracker } from "../../src/octocode/graph/stall.ts";
import { stalledItemAttention, stalledItemsText } from "../../src/octocode/monitor/attention/stalled-items.ts";
import { type StallSources, stallSubjects } from "../../src/octocode/subagents/stalled-items.ts";

const MIN = 60_000;
const subject = (lastProgressAt: number) => [{ ref: "B7", agent: "swift-orca", lastProgressAt }];

describe("stalled delegated items", () => {
	it("waits the owner's 20 minutes, then tells one stall once", () => {
		expect(STALL_MINUTES).toBe(20);
		const tracker = new StallTracker();
		expect(tracker.check(subject(0), 19 * MIN)).toEqual([]);
		expect(tracker.check(subject(0), 20 * MIN)).toEqual([
			{ ref: "B7", agent: "swift-orca", level: "stall", minutes: 20 },
		]);
		expect(tracker.check(subject(0), 45 * MIN)).toEqual([]);
	});

	it("asks for a re-plan on the second stall after progress, and raises nothing on the third", () => {
		const tracker = new StallTracker();
		expect(tracker.check(subject(0), 20 * MIN).map((alert) => alert.level)).toEqual(["stall"]);
		// Progress at 30 re-arms it; it stalls again 20 minutes later.
		expect(tracker.check(subject(30 * MIN), 40 * MIN)).toEqual([]);
		expect(tracker.check(subject(30 * MIN), 50 * MIN).map((alert) => alert.level)).toEqual(["replan"]);
		expect(tracker.check(subject(60 * MIN), 90 * MIN)).toEqual([]);
	});

	it("forgets an item that left the watch list, so a later delegation starts over", () => {
		const tracker = new StallTracker();
		tracker.check(subject(0), 20 * MIN);
		tracker.check([], 21 * MIN);
		expect(tracker.check(subject(30 * MIN), 50 * MIN).map((alert) => alert.level)).toEqual(["stall"]);
	});

	it("names the item and child in the nudge and records the silence against the limit", () => {
		const first = { ref: "B7", agent: "swift-orca", level: "stall" as const, minutes: 21 };
		const text = stalledItemsText([first, { ...first, ref: "B8", level: "replan" }]);
		expect(text.split("\n")).toHaveLength(2);
		expect(text).toMatch(/^B7 [^\n]*21 minutes[^\n]*swift-orca/);
		expect(text).toMatch(/\nB8 [^\n]*Re-plan/);
		expect(stalledItemAttention(first, STALL_MINUTES, 5)).toEqual({
			rule: "stalled-item",
			value: 21,
			threshold: 20,
			subject: "B7",
			at: 5,
		});
	});
});

describe("which delegated items the stall check watches", () => {
	const now = 100 * MIN;
	const sources = (over: Partial<StallSources> & Pick<StallSources, "served">): StallSources => ({
		item: (ref) => ({ ref, state: "ongoing", updatedAt: 0 }),
		jobs: new Set(),
		lastEdit: () => 0,
		lastOutput: () => now,
		...over,
	});
	const stalledAt = (watched: StallSources) =>
		new StallTracker().check(stallSubjects(watched, now), now).map((alert) => `${alert.ref}:${alert.agent}`);

	it("names neither a done item nor a child whose process ended", () => {
		const watched = sources({
			served: [
				["crisp-crane", "B863"],
				["lone-seal", "B864"],
			],
			item: (ref) => ({ ref, state: ref === "B863" ? "done" : "ongoing", updatedAt: 0 }),
			// lone-seal's run is still being finished by its parent, but its process exited.
			lastOutput: (agent) => (agent === "lone-seal" ? undefined : now),
		});
		expect(stalledAt(watched)).toEqual([]);
	});

	it("leaves a live child's queued item alone while the child moves its current one", () => {
		const watched = sources({
			served: [
				["quick-wren", "B1"],
				["quick-wren", "B2"],
			],
			item: (ref) => ({ ref, state: "ongoing", updatedAt: ref === "B1" ? now - 25 * MIN : 0 }),
			lastOutput: () => now - MIN,
		});
		expect(stalledAt(watched)).toEqual(["B1:quick-wren"]);
	});

	it("still names every item of a child silent for the whole window", () => {
		const watched = sources({
			served: [
				["quick-wren", "B1"],
				["quick-wren", "B2"],
			],
			lastOutput: () => now - 30 * MIN,
		});
		expect(stalledAt(watched)).toEqual(["B1:quick-wren", "B2:quick-wren"]);
	});

	it("counts a running job for the item as progress", () => {
		const watched = sources({ served: [["quick-wren", "B1"]], jobs: new Set(["B1"]) });
		expect(stallSubjects(watched, now)).toEqual([{ ref: "B1", agent: "quick-wren", lastProgressAt: now }]);
	});
});
