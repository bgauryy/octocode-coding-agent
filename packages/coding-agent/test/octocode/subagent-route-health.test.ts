import { afterEach, describe, expect, it, vi } from "vitest";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { describeModels } from "../../src/octocode/subagents/models-command.ts";
import { failedNext } from "../../src/octocode/subagents/report-text.ts";
import { type ModelRef, routeModel } from "../../src/octocode/subagents/model.ts";
import { ProviderHealth, providerHealth } from "../../src/octocode/subagents/provider-health.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";

const parent: ModelRef = { provider: "home", id: "big", cost: { input: 10, output: 40 } };
// Models that reason: a route's thinking level is kept as asked (a model without reasoning clamps it to off).
const available = [
	parent,
	{ provider: "other", id: "mid", cost: { input: 4, output: 16 } },
	{ provider: "cheap", id: "tiny", cost: { input: 0.1, output: 0.4 } },
].map((model) => ({ ...model, reasoning: true }) as ModelRef);
const refusedCheap = (provider: string) => provider === "cheap";

describe("routing and provider health (B347 P2-5)", () => {
	afterEach(() => vi.useRealTimers());

	it("skips a refused provider for a purpose and for a profile's preferred model", () => {
		expect(routeModel({ explicit: "small", available, parent })).toEqual({ model: "cheap/tiny" });
		expect(routeModel({ explicit: "small", available, parent, refused: refusedCheap })).toEqual({ model: "other/mid" });
		expect(routeModel({ preferred: "cheap/tiny", available, parent, refused: refusedCheap })).toEqual({
			model: "home/big",
			fallback: "cheap/tiny",
			refusedBy: "cheap",
		});
	});

	it("keeps an explicit model and the parent's own provider", () => {
		expect(routeModel({ explicit: "cheap/tiny", available, parent, refused: refusedCheap })).toEqual({
			model: "cheap/tiny",
		});
		// Every other provider refused: the parent's own provider still serves (its session proves the credential).
		const own = [...available, { provider: "home", id: "mini", cost: { input: 1, output: 4 } }];
		// `proven` marks the parent's provider: only a model-level refusal counts there.
		const everyCredential = (_provider: string, _id?: string, proven?: boolean) => !proven;
		expect(routeModel({ explicit: "small", available: own, parent, refused: everyCredential })).toEqual({
			model: "home/mini",
		});
		expect(routeModel({ explicit: "small", available, parent, refused: everyCredential })).toEqual({
			model: "home/big",
		});
	});

	it("counts only a recent credential refusal, not a timeout or an old refusal", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const health = new ProviderHealth();
		health.noteCheck("slow", "no answer within 20 s (the request ended: aborted)");
		health.noteRun("cheap/tiny", "401 Unauthorized: invalid api key");
		expect(health.refused("slow")).toBe(false);
		expect(health.refused("cheap")).toBe(true);
		vi.setSystemTime(1_000_000 + 16 * 60_000);
		expect(health.refused("cheap")).toBe(false);
		health.noteRun("cheap/tiny", "403 forbidden");
		health.noteRun("cheap/tiny");
		expect(health.refused("cheap")).toBe(false);
	});

	it("a model that refused a run before any token is skipped, even on the parent's provider; the parent's model never", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const health = new ProviderHealth();
		const refusal = 'opencode-go API error (400): {"error":{"type":"invalid_request_error"}}';
		// After work, or a timeout or rate limit: the task or the moment failed, not the route.
		health.noteRun("cheap/tiny:low", refusal, false);
		health.noteRun("cheap/tiny:low", "429 Too Many Requests", true);
		expect(health.refused("cheap", "tiny")).toBe(false);
		health.noteRun("cheap/tiny:low", refusal, true);
		expect(health.refused("cheap", "tiny")).toBe(true);
		expect(health.refused("cheap")).toBe(false);
		expect(health.refused("cheap", "other")).toBe(false);
		const refused = (provider: string, id?: string, proven?: boolean) => health.refused(provider, id, proven);
		expect(routeModel({ explicit: "small", available, parent, refused })).toEqual({ model: "other/mid" });
		const own = [...available, { provider: "home", id: "mini", cost: { input: 1, output: 4 } } as ModelRef];
		health.noteRun("home/mini", refusal, true);
		expect(routeModel({ explicit: "small", available: own, parent, refused })).toEqual({ model: "other/mid" });
		health.noteRun("home/big", refusal, true);
		expect(routeModel({ preferred: "home/big", available: own, parent, refused })).toEqual({ model: "home/big" });
		vi.setSystemTime(1_000_000 + 16 * 60_000);
		expect(health.refused("cheap", "tiny")).toBe(false);
	});

	it("advises the session's model after a client error before any token, not a narrower task", () => {
		const route = { model: "cheap/tiny:low", parent: "home/big" } as never;
		const refusal = "opencode-go API error (400): invalid_request_error";
		expect(failedNext(route, refusal, false, true)).toMatch(/Retry with model: "home\/big"/);
		expect(failedNext(route, refusal, false, false)).not.toMatch(/Retry with model/);
	});

	it("tells billing, request rejection and credential refusal apart", () => {
		const route = { model: "opencode-go/glm:low", parent: "home/big" } as never;
		const funds = failedNext(
			route,
			'402 {"error":{"type":"invalid_request_error","message":"Insufficient account funds"}}',
			false,
			true,
		);
		expect(funds).toMatch(/lack of funds.*key itself is fine.*add funds or a plan with opencode-go/);
		expect(funds).not.toMatch(/\/providers/);
		const shape = failedNext(
			route,
			"400 Upstream request failed: [invalid_request_error] Invalid request",
			false,
			true,
		);
		expect(shape).toMatch(/rejected the request.*credential is not the cause.*Retry with model: "home\/big"/);
		expect(shape).not.toMatch(/\/providers|funds/);
		const key = failedNext(route, "401 Unauthorized: invalid api key", false, true);
		expect(key).toMatch(/refused the credential.*\/providers/);
		// A rate limit and a partial answer keep their own advice.
		expect(failedNext(route, "429 Too Many Requests", true)).toMatch(/rate-limited.*partial answer is unverified/);
		// A client error after tokens were spent is about the task, not the route.
		expect(failedNext(route, "400 Invalid request", false, false)).not.toMatch(/rejected the request/);
	});

	it("planRun routes a purpose past a provider whose subagent run was refused", () => {
		const registry = { getAvailable: () => available, getProvider: () => undefined } as never;
		const profiles = new Map<string, AgentProfile>();
		const ctx = { modelRegistry: registry, model: parent as never };
		expect(planRun(profiles, { model: "small" }, ctx).route.model).toBe("cheap/tiny:medium");
		providerHealth.noteRun("cheap/tiny", "401 Unauthorized");
		try {
			expect(planRun(profiles, { model: "small" }, ctx).route.model).toBe("other/mid:medium");
		} finally {
			providerHealth.noteRun("cheap/tiny");
		}
	});

	it("the model listing routes as a run does after a refusal, and both say the credential was refused", () => {
		const registry = { getAvailable: () => available, getProvider: () => undefined } as never;
		const scoutProfile = { name: "scout", description: "", prompt: "", model: "cheap/tiny" } as AgentProfile;
		const profiles = new Map<string, AgentProfile>([["scout", scoutProfile]]);
		const ctx = { modelRegistry: registry, model: parent as never };
		providerHealth.noteRun("cheap/tiny", "401 Unauthorized");
		try {
			const small = planRun(profiles, { model: "small" }, ctx).route.model;
			const scout = planRun(profiles, { profile: "scout" }, ctx).route;
			expect(small).toBe("other/mid:medium");
			expect(scout).toMatchObject({ model: "home/big:medium", fallback: "cheap/tiny" });
			const listing = describeModels(available, parent, profiles, undefined);
			expect(listing).toContain("small: other/mid");
			expect(listing).toContain("scout: home/big:medium (cheap/tiny: cheap refused its credential)");
			expect(failedNext(scout, "boom", false)).toContain(
				"Ran on home/big, medium thinking (cheap/tiny: cheap refused its credential).",
			);
		} finally {
			providerHealth.noteRun("cheap/tiny");
		}
	});
});
