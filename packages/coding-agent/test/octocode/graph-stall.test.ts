import { describe, expect, it } from "vitest";
import { STALL_MINUTES, StallTracker } from "../../src/octocode/graph/stall.ts";
import { stalledItemAttention, stalledItemsText } from "../../src/octocode/monitor/attention/stalled-items.ts";

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
