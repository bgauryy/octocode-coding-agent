import { renderPrompt } from "../../src/core/prompt-template.ts";
import { describe, expect, it, vi } from "vitest";
import {
	budgetHeading,
	budgetOutcome,
	DEFAULT_MAX_REQUESTS,
	hardLimit,
	maxRequests,
	MAX_REQUESTS_ENV,
	RequestBudget,
	RunningBudgets,
	steerMessage,
	withStopFacts,
} from "../../src/octocode/subagents/budget.ts";
import { parseProfile } from "../../src/octocode/subagents/profiles.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { childStanding, grantRequests } from "../../src/octocode/team/tools/grant.ts";

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
		expect(steer).toHaveBeenCalledWith(steerMessage(3, 3, 5, { ask: true }));

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
		expect(steer).toHaveBeenCalledWith(steerMessage(5, 4, 6, { ask: true }));
	});

	it("selects the foreground steer when the parent cannot answer during the run", () => {
		const steer = vi.fn();
		const quiet = new RequestBudget(2, steer, vi.fn(), 0, { canAsk: false });
		quiet.onReply(2, true);
		expect(steer).toHaveBeenCalledWith(steerMessage(2, 2, 3));
	});

	describe("a grant", () => {
		it("adds to both limits, so the child runs past the old hard limit and is steered again at the new soft one", () => {
			const { steer, stop, budget: b } = budget(4);
			for (let count = 1; count <= 5; count++) b.onReply(count, true);
			expect(steer).toHaveBeenCalledTimes(1);
			expect(b.grant(4)).toEqual({ used: 5, soft: 8, hard: 10 });
			for (let count = 6; count <= 9; count++) b.onReply(count, true);
			expect(stop).not.toHaveBeenCalled();
			expect(steer).toHaveBeenCalledTimes(2);
			expect(steer).toHaveBeenLastCalledWith(steerMessage(8, 8, 10, { ask: true }));
			b.onReply(10, true);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(b.stopped).toBe(10);
		});

		it("does not repeat the steer when the new soft limit is already behind the child", () => {
			const { steer, budget: b } = budget(4);
			for (let count = 1; count <= 5; count++) b.onReply(count, true);
			expect(b.grant(1)).toEqual({ used: 5, soft: 5, hard: 7 });
			b.onReply(6, true);
			expect(steer).toHaveBeenCalledTimes(1);
		});

		it("does nothing once the budget has stopped the run, or when the budget is off", () => {
			const stopped = budget(1);
			stopped.budget.onReply(2, true);
			expect(stopped.budget.stopped).toBe(2);
			expect(stopped.budget.grant(5)).toBeUndefined();
			expect(budget(0).budget.grant(5)).toBeUndefined();
			expect(budget(0).budget.usage).toBeUndefined();
		});
	});

	describe("a resume", () => {
		const resumed = (soft: number, previous: number, options?: { resumeIsGrant?: boolean }) => {
			const steer = vi.fn();
			const stop = vi.fn();
			return { steer, stop, budget: new RequestBudget(soft, steer, stop, previous, options) };
		};

		it("below the soft limit shares what the child had, and its task is unchanged", () => {
			const { budget: b } = resumed(3, 2);
			expect(b.limits).toEqual({ soft: 3, hard: 5, allowance: 5 });
			expect(b.prompt("task")).toBe("task");
		});

		it("at or past the soft limit starts a whole allowance from where the child stands", () => {
			for (const previous of [3, 4, 5, 9]) {
				const { steer, stop, budget: b } = resumed(3, previous);
				expect(b.limits).toEqual({ soft: previous + 3, hard: previous + 5, allowance: 5 });
				expect(b.prompt("task")).toBe(
					`task\n\n${steerMessage(previous, previous + 3, previous + 5, { continued: true })}`,
				);
				b.onReply(1, true);
				b.onReply(2, true);
				expect(steer).not.toHaveBeenCalled();
				b.onReply(3, true);
				expect(steer).toHaveBeenCalledTimes(1);
				b.onReply(4, true);
				expect(stop).not.toHaveBeenCalled();
				b.onReply(5, true);
				expect(stop).toHaveBeenCalledTimes(1);
			}
		});

		it("by a relayed peer stays within the limits the child had: no parent decided it", () => {
			const { steer, stop, budget: b } = resumed(3, 4, { resumeIsGrant: false });
			expect(b.limits).toEqual({ soft: 3, hard: 5, allowance: 5 });
			expect(b.prompt("task")).toBe(`task\n\n${steerMessage(4, 3, 5, { continued: true })}`);
			b.onReply(1, true);
			expect(steer).not.toHaveBeenCalled();
			expect(stop).toHaveBeenCalledTimes(1);
		});

		it("leaves an off budget off", () => {
			const { steer, stop, budget: b } = resumed(0, 500);
			expect(b.prompt("task")).toBe("task");
			b.onReply(1, true);
			expect(steer).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
		});
	});
});

describe("RunningBudgets", () => {
	const running = (soft = 3) => {
		const budgets = new RunningBudgets();
		const budget = new RequestBudget(soft, vi.fn(), vi.fn());
		budgets.add("a-1", budget);
		return { budgets, budget };
	};

	it("shows and raises a running child", () => {
		const { budgets, budget } = running();
		budget.onReply(2, true);
		expect(budgets.usage("a-1")).toEqual({ used: 2, soft: 3, hard: 5 });
		expect(budgets.grant("a-1", 2)).toEqual({ used: 2, soft: 5, hard: 7 });
		expect(budgets.usage("a-1")).toEqual({ used: 2, soft: 5, hard: 7 });
	});

	it("refuses a child that is not running, or not this parent's, naming how to continue it", () => {
		const { budgets, budget } = running();
		expect(budgets.grant("other", 2)).toContain("is not running as a subagent you started");
		expect(budgets.grant("other", 2)).toContain("`resume: other`");
		expect(budgets.grant("other", 2)).toContain("Running: a-1.");
		budgets.remove("a-1", budget);
		expect(budgets.grant("a-1", 2)).toContain("Running: none.");
		expect(budgets.usage("a-1")).toBeUndefined();
	});

	it("keeps a newer run of the same child when the old one leaves", () => {
		const { budgets, budget } = running();
		const newer = new RequestBudget(3, vi.fn(), vi.fn());
		budgets.add("a-1", newer);
		budgets.remove("a-1", budget);
		expect(budgets.usage("a-1")).toBeDefined();
		budgets.remove("a-1", newer);
		expect(budgets.usage("a-1")).toBeUndefined();
	});

	it("refuses an off budget and a run the budget just stopped", () => {
		expect(running(0).budgets.grant("a-1", 2)).toContain("no request limit");
		const { budgets, budget } = running(1);
		budget.onReply(2, true);
		expect(budgets.grant("a-1", 2)).toContain("the budget has just stopped it");
	});
});

describe("coordinate grant", () => {
	const setup = (send = vi.fn(async () => ({ sent: ["a-1"], id: 7 }))) => {
		const budgets = new RunningBudgets();
		const budget = new RequestBudget(4, vi.fn(), vi.fn());
		budgets.add("a-1", budget);
		return {
			budgets,
			budget,
			send,
			team: { send, id: "main", asks: () => [] } as unknown as Parameters<typeof grantRequests>[0],
		};
	};

	it("raises the limits, tells the child through its mail, and says so", async () => {
		const { budgets, budget, send, team } = setup();
		budget.onReply(3, true);
		const result = await grantRequests(team, budgets, " a-1 ", 5);
		expect(budgets.usage("a-1")).toEqual({ used: 3, soft: 9, hard: 11 });
		expect(send).toHaveBeenCalledWith(
			"a-1",
			"Your coordinator granted 5 more model requests for this run: you have used 3, and the run now stops at 11.",
			{ replyRequired: false },
		);
		expect(result.content[0]).toMatchObject({
			text: "Granted 5 more requests to a-1 for this run: it has used 3 of 9 and stops at 11. It reads this at its next step (message #7).",
		});
	});

	it("names what the child has cost so far in the result, and nothing when no cost is counted", async () => {
		const { budgets, budget, team } = setup();
		budgets.add("a-1", budget, () => 0.4242);
		budget.onReply(3, true);
		expect(budgets.cost("a-1")).toBe(0.4242);
		const result = await grantRequests(team, budgets, "a-1", 5);
		expect(result.content[0]).toMatchObject({
			text: "Granted 5 more requests to a-1 for this run: it has used 3 of 9 (≈$0.42 so far) and stops at 11. It reads this at its next step (message #7).",
		});
		// A run that ended is counted no longer.
		budgets.remove("a-1", budget);
		expect(budgets.cost("a-1")).toBeUndefined();
		// A plan or an unpriced model reports no cost: the result names the requests alone.
		budgets.add("a-1", budget, () => 0);
		expect((await grantRequests(team, budgets, "a-1", 1)).content[0]).toMatchObject({
			text: expect.stringContaining("it has used 3 of 10 and stops at 12."),
		});
	});

	it("refuses anything but a positive whole number, an empty id and a subagent session, and raises nothing", async () => {
		const { budgets, send, team } = setup();
		for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, undefined])
			await expect(grantRequests(team, budgets, "a-1", bad)).rejects.toThrow("positive whole number");
		await expect(grantRequests(team, budgets, " ", 5)).rejects.toThrow("needs the id");
		await expect(grantRequests(team, undefined, "a-1", 5)).rejects.toThrow("Only the agent that started");
		await expect(grantRequests(team, budgets, "gone", 5)).rejects.toThrow("is not running");
		expect(budgets.usage("a-1")).toEqual({ used: 0, soft: 4, hard: 6 });
		expect(send).not.toHaveBeenCalled();
	});

	it("still raises the limits when the message fails", async () => {
		for (const send of [
			vi.fn(async () => ({ error: "no team" })),
			vi.fn(async () => {
				throw new Error("database is locked");
			}),
		]) {
			const { budgets, team } = setup(send as never);
			const result = await grantRequests(team, budgets, "a-1", 2);
			expect(budgets.usage("a-1")).toEqual({ used: 0, soft: 6, hard: 8 });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("could not be told") });
		}
	});

	it("shows a child's requests against its limit in the list, and nothing without a limit", () => {
		const member = {
			id: "a-1",
			role: "general",
			status: "working",
			pid: 1,
			joinedAt: 1,
			updatedAt: 1,
			toolCalls: 2,
			parentId: "main",
		} as never;
		expect(
			describeMembers([member], "main", 2, undefined, undefined, () => ({ used: 8, soft: 12, hard: 15 })),
		).toContain(" · 8 of 12 requests, stops at 15");
		expect(describeMembers([member], "main", 2, undefined, undefined, () => undefined)).not.toContain("requests");
		expect(describeMembers([member], "main", 2)).not.toContain("requests");
		// The context fill rides on the same line once the child's first reply says how full it is.
		const budgets = {
			grant: () => "no",
			usage: () => ({ used: 8, soft: 12, hard: 15 }),
			context: (id: string) => (id === "a-1" ? "context 75% (150k of 200k)" : undefined),
		};
		expect(describeMembers([member], "main", 2, undefined, undefined, (id) => childStanding(budgets, id))).toContain(
			" · 8 of 12 requests, stops at 15 · context 75% (150k of 200k)",
		);
		expect(childStanding({ ...budgets, context: () => undefined }, "a-1")).toEqual({ used: 8, soft: 12, hard: 15 });
	});
});

describe("budgetOutcome", () => {
	it("is partial, names the budget on its first line and carries the stop facts", () => {
		const outcome = budgetOutcome(
			5,
			{ soft: 3, hard: 5, allowance: 5 },
			{ id: "x-1" },
			"reading src/a.ts\n",
			emptyUsage(),
		);
		expect(outcome).toMatchObject({ outcome: "partial", outcomeSource: "first", budget: { requests: 5, limit: 3 } });
		expect(outcome.error).toBeUndefined();
		const [heading, next] = outcome.text.split("\n");
		expect(heading).toBe(
			renderPrompt("notices/subagents/budget-stop.md", { outcome: "partial", requests: 5, soft: 3, hard: 5 }),
		);
		// The heading helper names the same hard limit by default.
		expect(budgetHeading(5, 3)).toBe(heading);
		// The outcome word leads, then the requests made, the limit and the hard limit.
		expect(heading).toMatch(/^partial: .*\b5\b.*\b3\b.*\b5\b/);
		expect(next).toBe(
			renderPrompt("notices/subagents/budget-continue.md", { id: "x-1", isolated: false, allowance: 5 }),
		);
		expect(next).toContain("`resume: x-1`");
		expect(next).toMatch(/\b5\b/);
		expect(next).not.toContain("report:x-1");
		expect(outcome.text).toContain("Last progress:\nreading src/a.ts");
		const details = { id: "x-1", startedAt: Date.now(), activity: ["→ bash ls"] } as unknown as RunDetails;
		const withFacts = withStopFacts(outcome, details, { editLog: () => undefined });
		expect(withFacts.text).toContain("Last activity: → bash ls");
		expect(withFacts.text).toContain("Changed files: none recorded");
		const plain = { text: "t", usage: emptyUsage() };
		expect(withStopFacts(plain, details, { editLog: () => undefined })).toBe(plain);
	});

	it("names the limits a grant raised, and tells an isolated child's parent the resume needs its saved ref", () => {
		const outcome = budgetOutcome(
			15,
			{ soft: 12, hard: 15, allowance: 9 },
			{ id: "x-1", isolation: { path: "/w", repo: "/r", cwd: "/w" } },
			"",
			emptyUsage(),
		);
		const [heading, next] = outcome.text.split("\n");
		expect(outcome.text.split("\n")).toEqual([
			renderPrompt("notices/subagents/budget-stop.md", { outcome: "partial", requests: 15, soft: 12, hard: 15 }),
			renderPrompt("notices/subagents/budget-continue.md", { id: "x-1", isolated: true, allowance: 9 }),
		]);
		expect(heading).toMatch(/^partial: .*\b15\b.*\b12\b.*\b15\b/);
		expect(next).toContain("`resume: x-1`");
		expect(next).toMatch(/\b9\b/);
		// Only an isolated child's line names the report a new task cites when its saved ref is gone.
		expect(next).toContain("`report:x-1`");
		expect(outcome.budget).toEqual({ requests: 15, limit: 12 });
	});
});
