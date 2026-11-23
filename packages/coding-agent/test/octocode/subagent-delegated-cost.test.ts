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
const background = (total: number, details: object = {}) => ({
	type: "custom_message",
	details: { usage: usage(total), ...details },
});
const entries = (...list: object[]) => list as never[];
/** Every provider bills per token, except those in `plan`; the session runs on `faux`. */
const facts = (plan: string[] = []) => ({
	billingOf: (provider: string) => (plan.includes(provider) ? ("plan" as const) : ("metered" as const)),
	provider: "faux",
});
/** A session whose entries are `list`, on `faux/model`, with providers in `plan` billed by plan. */
const session = (list: unknown[], plan: string[] = []) =>
	({
		sessionManager: { getEntries: () => list },
		modelRegistry: { getProviderBilling: facts(plan).billingOf },
		model: { provider: "faux" },
	}) as never;

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
			facts(),
		);
		expect(spend.own).toBeCloseTo(0.75);
		expect(spend.delegated).toBeCloseTo(1);
	});

	it("counts money only: a reply, a run or a summary a plan paid for adds nothing", () => {
		const list = entries(
			reply(0.5),
			{ type: "message", message: { role: "assistant", provider: "codex", model: "gpt", usage: usage(3) } },
			// A child that ran on a plan provider, one whose runner named its plan, and one on the session's model.
			background(2, { model: "codex/gpt:high" }),
			background(4, { billing: "plan" }),
			background(0.25),
			{ type: "usage", kind: "side_question", provider: "codex", model: "gpt", usage: usage(1) },
		);
		const spend = sessionSpend(list, facts(["codex"]));
		expect(spend.own).toBeCloseTo(0.5);
		expect(spend.delegated).toBeCloseTo(0.25);
		// The session on a plan: its summaries are the plan's too. What a plan paid for of its own is kept apart, as the
		// basis the delegated-cost notice weighs a plan coordinator's children against (N14).
		const onPlan = { ...facts(["faux"]), provider: "faux" };
		expect(sessionSpend(entries({ type: "compaction", usage: usage(0.15) }, reply(1)), onPlan)).toEqual({
			own: 0,
			delegated: 0,
			ownPlan: 1.15,
		});
	});
});

describe("the notice when delegated cost passes a multiple of the session's own", () => {
	it("says so once per multiple, on the run that passed it", () => {
		const scope = {};
		const own = [reply(1)];
		// 0.6 of 1.00: below the session's own cost.
		expect(delegatedCostNote(scope, session(own), 0.6)).toBe("");
		// 0.6 + 0.6 passes it.
		expect(delegatedCostNote(scope, session([...own, background(0.6)]), 0.6)).toBe(
			"\n\nSubagents have now cost ≈$1.20 in this session: more than its own ≈$1.00. Nothing is stopped. Start or continue a subagent only for work that needs one, on the smallest model that settles it.",
		);
		// Still between one and two times: nothing more to say.
		expect(delegatedCostNote(scope, session([...own, background(1.2)]), 0.5)).toBe("");
		// One run can pass several multiples: the notice names the highest.
		expect(delegatedCostNote(scope, session([...own, background(1.7)]), 2.5)).toContain(
			"Subagents have now cost ≈$4.20 in this session: over 4 times its own ≈$1.00.",
		);
	});

	it("does not repeat a multiple after the session's own cost grew and the ratio fell back", () => {
		const scope = {};
		expect(delegatedCostNote(scope, session([reply(1)]), 2.1)).toContain("over 2 times");
		// The session spent more itself: the ratio is 1.05, then passes 2 again.
		expect(delegatedCostNote(scope, session([reply(2), foreground(2.1)]), 2)).toBe("");
		expect(delegatedCostNote(scope, session([reply(2), foreground(4.1)]), 2)).toContain("over 3 times");
	});

	it("does not repeat in a resumed session what the recorded runs already passed", () => {
		// A new process (a new scope) reads 2.5 times from the entries: only the third multiple is news.
		expect(delegatedCostNote({}, session([reply(1), background(2.5)]), 0.2)).toBe("");
		expect(delegatedCostNote({}, session([reply(1), background(2.5)]), 0.6)).toContain("over 3 times");
	});

	it("says nothing without a ratio: an unpriced run, or a session with no priced reply of its own", () => {
		expect(delegatedCostNote({}, session([reply(1)]), 0)).toBe("");
		expect(delegatedCostNote({}, session([reply(1)]), Number.NaN)).toBe("");
		expect(delegatedCostNote({}, session([]), 3)).toBe("");
		expect(delegatedCostNote({}, session([reply(0)]), 3)).toBe("");
	});

	it("names no multiple for a run a plan paid for", () => {
		expect(delegatedCostNote({}, session([reply(1)], ["codex"]), 3, { model: "codex/gpt" })).toBe("");
		expect(delegatedCostNote({}, session([reply(1)]), 3, { billing: "plan" })).toBe("");
		expect(delegatedCostNote({}, session([reply(1)], ["codex"]), 3, { model: "alt/x" })).toContain("over 3 times");
	});

	// Contract change (N14): a coordinator whose own replies a plan paid for spends no money of its own, so the notice used
	// to stay silent however much money its children spent. It now weighs that money against the plan's estimate of the
	// coordinator's own work, named as an estimate.
	it("weighs a plan-billed coordinator's metered children against its own plan estimate", () => {
		const scope = {};
		const onPlan = (list: unknown[]) => session(list, ["faux"]);
		// $1.00 of its own work, paid by the plan: a metered child's $0.60 is below it.
		expect(delegatedCostNote(scope, onPlan([reply(1)]), 0.6, { model: "alt/x" })).toBe("");
		expect(
			delegatedCostNote(scope, onPlan([reply(1), background(0.6, { model: "alt/x" })]), 2.5, { model: "alt/x" }),
		).toBe(
			"\n\nSubagents have now cost ≈$3.10 in this session: over 3 times its own ~$1.00 plan estimate. Nothing is stopped. Start or continue a subagent only for work that needs one, on the smallest model that settles it.",
		);
		// Its children on the plan spend no money: nothing to weigh.
		expect(delegatedCostNote({}, onPlan([reply(1)]), 3, { model: "faux/x" })).toBe("");
		// Money of its own is the basis again once it has some.
		const mixed = [
			reply(1),
			{ type: "message", message: { role: "assistant", provider: "alt", model: "x", usage: usage(2) } },
		];
		expect(delegatedCostNote({}, onPlan(mixed), 2.5, { model: "alt/x" })).toContain("more than its own ≈$2.00.");
	});

	it("lets a session it cannot read fail loudly instead of saying nothing", () => {
		expect(() => delegatedCostNote({}, session([null]), 1)).toThrow(TypeError);
	});
});
