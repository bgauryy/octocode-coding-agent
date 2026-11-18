import { describe, expect, it } from "vitest";
import { reportedAgent, totalSpend } from "../../src/octocode/shared/team-spend.ts";

const ledger = { cost: 1, unpriced: false };
const agent = (id: string, cost: number, parentId = "me", unpriced = false) => ({ id, parentId, cost, unpriced });

describe("the one total cost", () => {
	it("adds every live descendant to the ledger until it reports", () => {
		const live = [agent("a", 0.5), agent("b", 0.25, "a")];
		expect(totalSpend(ledger, live, new Set())).toEqual({ cost: 1.75, unpriced: false });
	});

	it("counts a reported agent and the children it waited for once, from the ledger", () => {
		const live = [agent("a", 0.5), agent("b", 0.25, "a"), agent("c", 2)];
		// a's result holds its own spend and b's: the ledger has them, c is still only live.
		expect(totalSpend({ cost: 1.75, unpriced: false }, live, new Set(["a"]))).toEqual({ cost: 3.75, unpriced: false });
	});

	it("marks the total unpriced when a pending agent is, and not once it reported", () => {
		const live = [agent("a", 0, "me", true)];
		expect(totalSpend(ledger, live, new Set()).unpriced).toBe(true);
		expect(totalSpend(ledger, live, new Set(["a"])).unpriced).toBe(false);
	});

	it("survives a parent cycle in the rows", () => {
		const live = [agent("a", 1, "b"), agent("b", 1, "a")];
		expect(totalSpend(ledger, live, new Set()).cost).toBe(3);
	});
});

describe("which message reports an agent", () => {
	const usage = { input: 1, output: 1, cost: { total: 0.1 } };

	it("names the agent of a foreground result and of a background report", () => {
		expect(reportedAgent({ role: "toolResult", toolName: "agent", usage, details: { id: "sly-crab" } })).toBe(
			"sly-crab",
		);
		expect(
			reportedAgent({ role: "custom", customType: "octocode-agent-result", details: { id: "sly-crab", usage } }),
		).toBe("sly-crab");
	});

	it("names none for a launch without usage, another tool or another message", () => {
		expect(reportedAgent({ role: "toolResult", toolName: "agent", details: { id: "sly-crab" } })).toBeUndefined();
		expect(reportedAgent({ role: "toolResult", toolName: "bash", usage, details: { id: "x" } })).toBeUndefined();
		expect(
			reportedAgent({ role: "custom", customType: "octocode-agent-message", details: { id: "x" } }),
		).toBeUndefined();
		expect(reportedAgent({ role: "assistant", usage })).toBeUndefined();
	});
});
