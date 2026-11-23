import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { agentToolSpec } from "../../src/octocode/native/tools/agent/spec.ts";
import { requestBudgetHistory } from "../../src/octocode/subagents/budget-history.ts";
import {
	DEFAULT_MAX_REQUESTS,
	hardLimit,
	RequestBudget,
	steerMessage,
	taskRequestLimit,
} from "../../src/octocode/subagents/budget.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { type AgentProfile, loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { runnerPlan } from "../../src/octocode/subagents/runner-task.ts";
import { tmp } from "./helpers.ts";

const researcher = { name: "researcher", maxRequests: 40 };
/** A loaded profile with only the fields the budget reads. */
const profile = (maxRequests: number) =>
	({ name: "researcher", description: "", prompt: "", maxRequests }) satisfies AgentProfile;

describe("a task's own request limit (maxRequests)", () => {
	it("is declared on the task as an integer, so the schema refuses a fraction or text", () => {
		const parameters = agentToolSpec().parameters;
		const task = { task: "find callers", goal: "Find callers" };
		expect(Check(parameters, { ...task, maxRequests: 20 })).toBe(true);
		expect(Check(parameters, { ...task, maxRequests: 2.5 })).toBe(false);
		expect(Check(parameters, { ...task, maxRequests: "20" })).toBe(false);
		const field = parameters.properties.maxRequests as { description?: string };
		expect(field.description).toContain(`default ${DEFAULT_MAX_REQUESTS}`);
	});

	it("only lowers the profile's limit, and a higher one is refused with that limit", () => {
		expect(taskRequestLimit(researcher, undefined)).toBe(40);
		expect(taskRequestLimit(researcher, 12)).toBe(12);
		expect(taskRequestLimit(researcher, 40)).toBe(40);
		expect(() => taskRequestLimit(researcher, 41)).toThrow(
			"maxRequests 41 is above the researcher profile's limit of 40 requests: pass at most 40, or omit it.",
		);
		expect(() => taskRequestLimit(undefined, 500, {})).toThrow(/above the default limit of 160 requests/);
		for (const bad of [0, -3, 1.5, "20"]) expect(() => taskRequestLimit(researcher, bad)).toThrow(/positive integer/);
		// A profile with its budget off (0) has no limit to exceed: any cap lowers it.
		expect(taskRequestLimit({ name: "long", maxRequests: 0 }, 500)).toBe(500);
	});

	it("is checked when the task is planned, before anything claims, waits or asks", () => {
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		const registry = { getAvailable: () => [], getProviderAuthStatus: () => ({ source: "stored" }) } as never;
		const plan = (maxRequests?: number) =>
			planRun(profiles, { profile: "researcher", maxRequests }, { modelRegistry: registry } as never);
		const limit = taskRequestLimit(profiles.get("researcher"), undefined);
		expect(() => plan(limit + 1)).toThrow(`limit of ${limit} requests`);
		expect(plan(12).requests).toBe(12);
		expect(plan()).not.toHaveProperty("requests");
		// A vendor runner keeps its own session and budget: the field is refused there, not ignored.
		const runners = { ids: ["claude-code"], turn: vi.fn() };
		expect(() => runnerPlan({ runner: "claude-code", maxRequests: 12 }, runners)).toThrow(
			"A runner task does not take maxRequests.",
		);
	});

	it("becomes the child's budget: steered at the cap, stopped at 1.5 times it", async () => {
		const history = await requestBudgetHistory([], profile(160), { id: "r", maxRequests: 12 });
		expect(history.limit).toBe(12);
		const steer = vi.fn();
		const stop = vi.fn();
		const budget = new RequestBudget(history.limit, steer, stop, history.requests);
		for (let count = 1; count <= 20; count++) budget.onReply(count, true);
		expect(steer).toHaveBeenCalledExactlyOnceWith(steerMessage(12, 12, hardLimit(12), { ask: true }));
		expect(budget.stopped).toBe(hardLimit(12));
		expect(budget.limits).toEqual({ soft: 12, hard: 18, allowance: 18 });
		// Without a cap the profile's limit stands.
		expect((await requestBudgetHistory([], profile(30), { id: "r" })).limit).toBe(30);
	});
});
