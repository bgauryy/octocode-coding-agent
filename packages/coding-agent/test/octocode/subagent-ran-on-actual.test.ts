import { describe, expect, it } from "vitest";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import type { RunRoute } from "../../src/octocode/subagents/claim.ts";
import { failedNext, ranOn } from "../../src/octocode/subagents/report-text.ts";
import { runDetails, tracker } from "../../src/octocode/subagents/tracking.ts";
import { FALLBACK_ENTRY } from "../../src/core/agent-session/fallback-switch.ts";

const LIMITS = { idleMs: 1_000, busyMs: 5_000 };
const PLANNED: RunRoute = {
	model: "cheap/tiny:low",
	via: "profile scout: small:low",
	fallbackModels: ["other/mid:medium"],
};

const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (provider: string, model: string, stopReason = "stop") => ({
	type: "message_end",
	message: { role: "assistant", provider, model, stopReason, content: [{ type: "text", text: "done" }], usage },
});
const notice = (message: string) => ({
	type: "extension_ui_request",
	method: "notify",
	notifyType: "warning",
	message,
});
/** The child's fallback switch: the session entry `retry-fallback.ts` appends, sent as `entry_appended`. */
const switched = (billingChanged = false) => ({
	type: "entry_appended",
	entry: {
		type: "custom",
		customType: FALLBACK_ENTRY,
		id: "e1",
		parentId: null,
		timestamp: "2026-11-23T00:00:00.000Z",
		data: { from: "cheap/tiny", to: "other/mid", reason: "hit a usage limit", billingChanged },
	},
});
const FALLBACK_NOTICE =
	"cheap/tiny hit a usage limit; continuing on other/mid (retry.fallbackModels). /model switches back.";

/** Plays child events through the reducer and the tracker, as a run does, and returns the run's details. */
function play(route: RunRoute, events: Record<string, unknown>[]) {
	const identity = { id: "scout-1", role: "scout", goal: "look" };
	const details = runDetails({ identity, route } as Parameters<typeof runDetails>[0]);
	const track = tracker(identity, details, () => undefined)(undefined);
	const state = newChildState();
	for (const event of events)
		for (const effect of reduceEvent(state, event, LIMITS, 100_000))
			if (effect.kind === "progress") track(effect.update);
	return details;
}

describe("ranOn: the model that answered", () => {
	it("names the fallback that answered, the planned model and the cause the child recorded", () => {
		const details = play(PLANNED, [assistant("cheap", "tiny", "error"), switched(), assistant("other", "mid")]);
		expect(details.ran?.fallback).toEqual({
			from: "cheap/tiny",
			to: "other/mid",
			reason: "hit a usage limit",
			billingChanged: false,
		});
		expect(ranOn(PLANNED, details.ran)).toBe(
			"Ran on other/mid, medium thinking (fallback from cheap/tiny: hit a usage limit).",
		);
	});

	it("says when the switch changed how the run is billed", () => {
		const details = play(PLANNED, [assistant("cheap", "tiny", "error"), switched(true), assistant("other", "mid")]);
		expect(ranOn(PLANNED, details.ran)).toBe(
			"Ran on other/mid, medium thinking (fallback from cheap/tiny: hit a usage limit; billing changed).",
		);
	});

	it("reads the switch from the structured entry, never from the prose notice", () => {
		const details = play(PLANNED, [
			assistant("cheap", "tiny", "error"),
			notice(FALLBACK_NOTICE),
			assistant("other", "mid"),
		]);
		expect(details.ran).toEqual({ model: "other/mid" });
	});

	it("names the planned model without a cause when the child recorded none", () => {
		const details = play(PLANNED, [assistant("other", "mid")]);
		expect(ranOn(PLANNED, details.ran)).toBe("Ran on other/mid, medium thinking (fallback from cheap/tiny).");
	});

	it("is unchanged when the last assistant message came from the planned model", () => {
		const details = play(PLANNED, [assistant("cheap", "tiny")]);
		expect(ranOn(PLANNED, details.ran)).toBe(ranOn(PLANNED));
		expect(ranOn(PLANNED, details.ran)).toBe("Ran on cheap/tiny, low thinking (profile scout: small:low).");
	});

	it("is unchanged when no assistant message arrived, even with a fallback switch", () => {
		const details = play(PLANNED, [notice(FALLBACK_NOTICE), switched()]);
		expect(details.ran).toBeUndefined();
		expect(ranOn(PLANNED, details.ran)).toBe(ranOn(PLANNED));
	});

	it("reads the model of the last assistant message", () => {
		const details = play(PLANNED, [assistant("other", "mid", "toolUse"), assistant("cheap", "tiny")]);
		expect(ranOn(PLANNED, details.ran)).toBe(ranOn(PLANNED));
	});

	it("names no model for a route that runs on the session's model", () => {
		const details = play({}, [assistant("other", "mid")]);
		expect(ranOn({}, details.ran)).toBe("");
	});

	it("names the provider that ran, not the planned one, in a refusal's advice", () => {
		const details = play(PLANNED, [
			assistant("cheap", "tiny", "error"),
			switched(),
			assistant("other", "mid", "error"),
		]);
		const advice = failedNext(PLANNED, "other/mid: 401 Incorrect API key provided", false, true, details.ran);
		expect(advice).toContain("other credential");
		expect(advice).not.toContain("cheap credential");
	});

	it("puts the actual model in a failure's closing line", () => {
		const details = play(PLANNED, [assistant("other", "mid", "error")]);
		expect(failedNext(PLANNED, "boom", false, false, details.ran)).toContain(
			"Ran on other/mid, medium thinking (fallback from cheap/tiny).",
		);
	});
});
