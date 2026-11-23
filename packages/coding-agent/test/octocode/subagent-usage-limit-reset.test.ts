import { describe, expect, it } from "vitest";
import { resetText, USAGE_LIMIT_ENTRY } from "../../src/core/agent-session/usage-limit-facts.ts";
import type { RunRoute } from "../../src/octocode/subagents/claim.ts";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { failedAdvice } from "../../src/octocode/subagents/report-text.ts";
import { runDetails, tracker } from "../../src/octocode/subagents/tracking.ts";

const LIMITS = { idleMs: 1_000, busyMs: 5_000 };
const ROUTE: RunRoute = { model: "codex/gpt", parent: "home/big" };
const LIMIT = '429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';

/** The entry an unattended child appends when its turn ends on a usage limit (`usage-limit-recovery.ts`). */
const limited = (resetsAt?: number) => ({
	type: "entry_appended",
	entry: {
		type: "custom",
		customType: USAGE_LIMIT_ENTRY,
		id: "u1",
		parentId: null,
		timestamp: "2026-11-23T00:00:00.000Z",
		data: { provider: "codex", model: "codex/gpt", ...(resetsAt === undefined ? {} : { resetsAt }) },
	},
});
const failed = {
	type: "message_end",
	message: {
		role: "assistant",
		provider: "codex",
		model: "gpt",
		stopReason: "error",
		errorMessage: LIMIT,
		content: [],
	},
};

/** Plays child events through the reducer and the tracker, as a run does, and returns the run's details. */
function play(events: Record<string, unknown>[]) {
	const identity = { id: "scout-1", role: "scout", goal: "look" };
	const details = runDetails({ identity, route: ROUTE } as Parameters<typeof runDetails>[0]);
	const track = tracker(identity, details, () => undefined)(undefined);
	const state = newChildState();
	for (const event of events)
		for (const effect of reduceEvent(state, event, LIMITS, 100_000))
			if (effect.kind === "progress") track(effect.update);
	return details;
}

describe("a child's usage limit in its parent's failure advice", () => {
	it("names when the limit resets, from the child's usage-limit entry", () => {
		const resetsAt = Date.now() + 2 * 3_600_000;
		const details = play([failed, limited(resetsAt)]);
		expect(details.usageLimit).toEqual({ provider: "codex", model: "codex/gpt", resetsAt });
		const advice = failedAdvice(ROUTE, LIMIT, { text: "" }, details);
		expect(advice).toContain("usage limit (the key itself is fine)");
		expect(advice).toContain(`The limit ${resetText(resetsAt, Date.now())}.`);
	});

	it("says nothing of a reset the child did not know, or when no entry came", () => {
		for (const events of [[failed, limited()], [failed]]) {
			const advice = failedAdvice(ROUTE, LIMIT, { text: "" }, play(events));
			expect(advice).toContain("usage limit (the key itself is fine)");
			expect(advice).not.toContain("The limit resets");
		}
	});
});
