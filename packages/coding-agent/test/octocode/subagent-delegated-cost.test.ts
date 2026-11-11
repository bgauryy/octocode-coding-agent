import { describe, expect, it } from "vitest";
import { delegatedCostNote, sessionSpend } from "../../src/octocode/subagents/delegated-cost.ts";

const usage = (total: number) => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { total },
});
const reply = (total: number) => ({
	type: "message",
	message: { role: "assistant", provider: "faux", model: "model", usage: usage(total) },
});
const foreground = (total: number, toolName = "agent") => ({
	type: "message",
	message: { role: "toolResult", toolName, usage: usage(total) },
});
const background = (total: number) => ({ type: "custom_message", details: { usage: usage(total) } });
const entries = (...list: object[]) => list as never[];

describe("a session's spend, split by who spent it", () => {
	it("counts foreground and background subagent runs as delegated and everything else as its own", () => {
		const spend = sessionSpend(
			entries(
				reply(0.5),
				foreground(0.25),
				background(0.75),
				// Another tool's own model usage and a compaction summary are the session's.
				foreground(0.1, "web"),
				{ type: "compaction", usage: usage(0.15) },
				{ type: "custom_message", details: {} },
			),
		);
		expect(spend.own).toBeCloseTo(0.75);
		expect(spend.delegated).toBeCloseTo(1);
	});
});

describe("the notice when delegated cost passes a multiple of the session's own", () => {
	it("says so once per multiple, on the run that passed it", () => {
		const scope = {};
		const own = [reply(1)];
		// 0.6 of 1.00: below the session's own cost.
		expect(delegatedCostNote(scope, entries(...own), 0.6)).toBe("");
		// 0.6 + 0.6 passes it.
		expect(delegatedCostNote(scope, entries(...own, background(0.6)), 0.6)).toBe(
			"\n\nSubagents have now cost ≈$1.20 in this session: more than its own ≈$1.00. Nothing is stopped. Before you start or continue a subagent, check that the task needs one, and do a small step yourself.",
		);
		// Still between one and two times: nothing more to say.
		expect(delegatedCostNote(scope, entries(...own, background(1.2)), 0.5)).toBe("");
		// One run can pass several multiples: the notice names the highest.
		expect(delegatedCostNote(scope, entries(...own, background(1.7)), 2.5)).toContain(
			"Subagents have now cost ≈$4.20 in this session: over 4 times its own ≈$1.00.",
		);
	});

	it("does not repeat a multiple after the session's own cost grew and the ratio fell back", () => {
		const scope = {};
		expect(delegatedCostNote(scope, entries(reply(1)), 2.1)).toContain("over 2 times");
		// The session spent more itself: the ratio is 1.05, then passes 2 again.
		expect(delegatedCostNote(scope, entries(reply(2), foreground(2.1)), 2)).toBe("");
		expect(delegatedCostNote(scope, entries(reply(2), foreground(4.1)), 2)).toContain("over 3 times");
	});

	it("does not repeat in a resumed session what the recorded runs already passed", () => {
		// A new process (a new scope) reads 2.5 times from the entries: only the third multiple is news.
		expect(delegatedCostNote({}, entries(reply(1), background(2.5)), 0.2)).toBe("");
		expect(delegatedCostNote({}, entries(reply(1), background(2.5)), 0.6)).toContain("over 3 times");
	});

	it("says nothing without a ratio: an unpriced run, or a session with no priced reply of its own", () => {
		expect(delegatedCostNote({}, entries(reply(1)), 0)).toBe("");
		expect(delegatedCostNote({}, entries(reply(1)), Number.NaN)).toBe("");
		expect(delegatedCostNote({}, entries(), 3)).toBe("");
		expect(delegatedCostNote({}, entries(reply(0)), 3)).toBe("");
	});

	it("fails open when the entries cannot be read", () => {
		expect(delegatedCostNote({}, [null] as never, 1)).toBe("");
	});
});
