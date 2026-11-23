import type { Usage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { type BillingFacts, combineUsage, entryBilling, meteredCost, runBilling } from "../src/core/usage-totals.ts";

const legacy: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

describe("mixed cache usage aggregation", () => {
	it("preserves long-write subsets without counting them again in token or cost totals", () => {
		const first = { ...legacy, cacheWrite12h: 2 };
		const second = { ...legacy, cacheWrite1h: 1, cacheWrite12h: 3 };
		expect(combineUsage(first, second)).toMatchObject({
			cacheWrite: 8,
			cacheWrite1h: 1,
			cacheWrite12h: 5,
			totalTokens: 20,
			cost: { total: 20 },
		});
	});
	it("keeps old transcripts readable without inventing a lifetime breakdown", () => {
		expect(combineUsage(legacy, legacy)).not.toHaveProperty("cacheWrite12h");
		expect(combineUsage(legacy, { ...legacy, cacheWrite12h: 2 }).cacheWrite12h).toBe(2);
	});
});

describe("who paid for an entry", () => {
	/** `codex` bills by plan; a child on `alt` is given an API key, so it pays per token there. */
	const facts: BillingFacts = {
		billingOf: (provider, scope) =>
			provider === "codex" || (provider === "alt" && scope !== "child") ? "plan" : "metered",
		provider: "codex",
	};
	const assistant = (provider: string) =>
		({ type: "message", message: { role: "assistant", provider, model: "m", usage: legacy } }) as never;
	const agentResult = (details: object) =>
		({ type: "message", message: { role: "toolResult", toolName: "agent", details, usage: legacy } }) as never;

	it("bills a reply or a usage entry by its provider, and a summary by the session's", () => {
		expect(entryBilling(assistant("codex"), facts)).toBe("plan");
		expect(entryBilling(assistant("anthropic"), facts)).toBe("metered");
		expect(entryBilling({ type: "usage", provider: "anthropic", usage: legacy } as never, facts)).toBe("metered");
		expect(entryBilling({ type: "compaction", usage: legacy } as never, facts)).toBe("plan");
		expect(entryBilling({ type: "compaction", usage: legacy } as never, { ...facts, provider: undefined })).toBe(
			"metered",
		);
	});

	it("bills a subagent run by its runner's billing, else the model it last ran on as a child, else the session's", () => {
		expect(runBilling({ billing: "plan", model: "anthropic/x" }, facts)).toBe("plan");
		expect(runBilling({ model: "anthropic/x", ran: { model: "codex/gpt" } }, facts)).toBe("plan");
		expect(runBilling({ model: "alt/x:high" }, facts)).toBe("metered");
		expect(runBilling({}, facts)).toBe("plan");
		expect(runBilling(undefined, { billingOf: facts.billingOf })).toBe("metered");
		expect(entryBilling(agentResult({ model: "anthropic/x" }), facts)).toBe("metered");
	});

	it("counts money only", () => {
		expect(meteredCost(assistant("codex"), facts)).toBe(0);
		expect(meteredCost(assistant("anthropic"), facts)).toBe(10);
		expect(meteredCost({ type: "label" } as never, facts)).toBe(0);
	});
});
