import { describe, expect, it, vi } from "vitest";
import {
	budgetHeading,
	budgetOutcome,
	DEFAULT_MAX_REQUESTS,
	hardLimit,
	maxRequests,
	MAX_REQUESTS_ENV,
	RequestBudget,
	steerMessage,
	withStopFacts,
} from "../../src/octocode/subagents/budget.ts";
import { parseProfile } from "../../src/octocode/subagents/profiles.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";

describe("maxRequests resolution", () => {
	const env = (value?: string) => (value === undefined ? {} : { [MAX_REQUESTS_ENV]: value });

	it("defaults to 160 requests", () => {
		expect(DEFAULT_MAX_REQUESTS).toBe(160);
		expect(maxRequests(undefined, env())).toBe(160);
		expect(hardLimit(DEFAULT_MAX_REQUESTS)).toBe(240);
	});

	it("takes the environment next: a non-negative integer, 0 turning the budget off", () => {
		expect(maxRequests(undefined, env("40"))).toBe(40);
		expect(maxRequests(undefined, env("0"))).toBe(0);
		for (const bad of ["-3", "abc", "1.5", ""]) expect(maxRequests(undefined, env(bad))).toBe(160);
	});

	it("lets the profile win over the environment, and 0 in a profile turns the budget off", () => {
		expect(maxRequests({ maxRequests: 12 }, env("40"))).toBe(12);
		expect(maxRequests({ maxRequests: 0 }, env("40"))).toBe(0);
		expect(maxRequests({}, env("40"))).toBe(40);
	});

	it("reads maxRequests from profile front matter and refuses a bad value", () => {
		expect(parseProfile("p", "---\nname: p\nmaxRequests: 30\n---\nBody.").maxRequests).toBe(30);
		expect(parseProfile("p", "---\nname: p\nmaxRequests: 0\n---\nBody.").maxRequests).toBe(0);
		expect(parseProfile("p", "---\nname: p\n---\nBody.")).not.toHaveProperty("maxRequests");
		for (const bad of ["-1", "2.5", '"30"', "true"])
			expect(() => parseProfile("p", `---\nname: p\nmaxRequests: ${bad}\n---\nBody.`)).toThrow(/maxRequests/);
	});
});

describe("RequestBudget", () => {
	const budget = (soft: number) => {
		const steer = vi.fn();
		const stop = vi.fn();
		return { steer, stop, budget: new RequestBudget(soft, steer, stop) };
	};

	it("computes the hard limit as 1.5 times the soft limit, rounded up", () => {
		expect([1, 2, 3, 10, 40].map(hardLimit)).toEqual([2, 3, 5, 15, 60]);
	});

	it("steers once at the soft limit and stops once at the hard limit", () => {
		const { steer, stop, budget: b } = budget(3);
		for (let count = 1; count <= 8; count++) b.onReply(count, true);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith(
			"You have used 3 of 3 model requests. Finish now: report what is done, what is partial, and the next step.",
		);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(b.stopped).toBe(5);
	});

	it("does nothing when off, or for a reply that ends the run", () => {
		const off = budget(0);
		for (let count = 1; count <= 100; count++) off.budget.onReply(count, true);
		expect(off.steer).not.toHaveBeenCalled();
		expect(off.stop).not.toHaveBeenCalled();
		const final = budget(2);
		for (let count = 1; count <= 10; count++) final.budget.onReply(count, false);
		expect(final.steer).not.toHaveBeenCalled();
		expect(final.stop).not.toHaveBeenCalled();
	});

	it("steers at the first continuing reply past the soft limit when the one at it ended the run", () => {
		const { steer, budget: b } = budget(4);
		b.onReply(4, false);
		b.onReply(5, true);
		expect(steer).toHaveBeenCalledWith(steerMessage(5, 4));
	});
});

describe("budgetOutcome", () => {
	it("is partial, names the budget on its first line and carries the stop facts", () => {
		const outcome = budgetOutcome(5, 3, "reading src/a.ts\n", emptyUsage());
		expect(outcome).toMatchObject({ outcome: "partial", outcomeSource: "first", budget: { requests: 5, limit: 3 } });
		expect(outcome.error).toBeUndefined();
		expect(outcome.text.split("\n")[0]).toBe(budgetHeading(5, 3));
		expect(outcome.text.split("\n")[0]).toMatch(/^partial: stopped at the model request budget \(5 requests; limit 3/);
		expect(outcome.text).toContain("Last progress:\nreading src/a.ts");
		const details = { id: "x-1", startedAt: Date.now(), activity: ["→ bash ls"] } as unknown as RunDetails;
		const withFacts = withStopFacts(outcome, details, { editLog: () => undefined });
		expect(withFacts.text).toContain("Last activity: → bash ls");
		expect(withFacts.text).toContain("Changed files: none recorded");
		const plain = { text: "t", usage: emptyUsage() };
		expect(withStopFacts(plain, details, { editLog: () => undefined })).toBe(plain);
	});
});
