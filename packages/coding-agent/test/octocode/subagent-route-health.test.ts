import { afterEach, describe, expect, it, vi } from "vitest";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { describeModels, routingFacts } from "../../src/octocode/subagents/models-command.ts";
import { failedNext } from "../../src/octocode/subagents/report-text.ts";
import { type ModelRef, type Refused, routeModel } from "../../src/octocode/subagents/model.ts";
import { ProviderHealth, providerHealth } from "../../src/octocode/subagents/provider-health.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { meteredBilling } from "./fake-host.ts";

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
		expect(routeModel({ explicit: "small", available, parent })).toEqual({
			model: "cheap/tiny",
			fallbackModels: ["other/mid"],
		});
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

	it.each([
		'Validation error: 400 {"message":"The provided model identifier is invalid."}',
		'AccessDeniedException: 403 {"message":"This model is not available for this account."}',
		"403 You do not have access to model tiny",
		"403 Access to this model is denied",
		"403 Model tiny is not available for your account",
	])("keeps a model access refusal scoped to that route: %s", (error) => {
		const health = new ProviderHealth();
		health.noteRun("cheap/tiny:low", error, true);
		const sibling = { provider: "cheap", id: "allowed", cost: { input: 0.2, output: 0.5 } };
		const models = [...available, sibling];
		const refused = health.refused.bind(health);
		expect(health.refused("cheap", "tiny")).toBe(true);
		expect(health.refused("cheap", "tiny", true)).toBe(true);
		expect(health.refused("cheap", "allowed")).toBe(false);
		expect(health.refused("other", "tiny")).toBe(false);
		expect(health.refused("cheap")).toBe(false);
		expect(routeModel({ explicit: "small", available: models, parent, refused })).toEqual({
			model: "cheap/allowed",
			fallbackModels: ["other/mid"],
		});
		expect(routeModel({ preferred: "cheap/allowed", available: models, parent: available[2], refused })).toEqual({
			model: "cheap/allowed",
		});
		expect(routeModel({ preferred: "cheap/tiny", available: models, parent: available[2], refused })).toEqual({
			model: "cheap/tiny",
		});
		const advice = failedNext({ model: "cheap/tiny", parent: "home/big" }, error, false, true);
		expect(advice).not.toContain("/providers");
		expect(advice).toContain('Retry with model: "home/big"');
		health.noteRun("cheap/tiny");
		expect(health.refused("cheap", "tiny")).toBe(false);
	});

	it.each([
		"401 Unauthorized for model tiny",
		"403 Invalid API key for model tiny",
		"403 API key has expired; no access to model tiny",
		"403 forbidden",
	])("keeps credential-wide refusals provider scoped: %s", (error) => {
		const health = new ProviderHealth();
		health.noteRun("cheap/tiny", error, true);
		expect(health.refused("cheap", "allowed")).toBe(true);
		expect(health.refused("cheap", "allowed", true)).toBe(false);
		expect(health.refused("other", "tiny")).toBe(false);
	});

	it("counts a credential refusal until it is lifted, a usage limit only while recent, and not a timeout", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const health = new ProviderHealth();
		health.noteCheck("slow", "no answer within 20 s (the request ended: aborted)");
		health.noteRun("cheap/tiny", "401 Unauthorized: invalid api key");
		health.noteRun("other/mid", "429 Monthly usage limit reached");
		expect(health.refused("slow")).toBe(false);
		expect(health.refused("cheap")).toBe(true);
		expect(health.refused("other")).toBe(true);
		vi.setSystemTime(1_000_000 + 16 * 60_000);
		expect(health.refused("cheap")).toBe(true);
		expect(health.refused("other")).toBe(false);
		health.noteRun("cheap/tiny", "403 forbidden");
		health.noteRun("cheap/tiny");
		expect(health.refused("cheap")).toBe(false);
	});

	it("a provider out of funds still routes its free models, not its priced ones", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const health = new ProviderHealth();
		health.noteCheck("go", 'paid: 402 {"error":{"message":"Insufficient account funds"}}');
		const paid = { provider: "go", id: "paid", cost: { input: 1, output: 4 } } as ModelRef;
		const free = { provider: "go", id: "free", cost: { input: 0, output: 0 }, reasoning: true } as ModelRef;
		expect(health.refused("go", "paid", false, paid.cost)).toBe(true);
		expect(health.refused("go", "free", false, free.cost)).toBe(false);
		// An unknown price is not free.
		expect(health.refused("go")).toBe(true);
		const refused: Refused = (provider, id, proven, cost) => health.refused(provider, id, proven, cost);
		const models = [parent, paid, free];
		expect(routingFacts(models, parent, [], undefined, refused)?.providers.map((row) => row.id)).toEqual([
			"go",
			"home",
		]);
		expect(routeModel({ preferred: "go/free", available: models, parent, refused })).toEqual({ model: "go/free" });
		expect(routeModel({ preferred: "go/paid", available: models, parent, refused })).toMatchObject({
			model: "home/big",
			refusedBy: "go",
		});
		// A refused key blocks the free model too.
		health.noteCheck("go", "401 Unauthorized");
		expect(health.refused("go", "free", false, free.cost)).toBe(true);
		expect(routingFacts(models, parent, [], undefined, refused)?.providers.map((row) => row.id)).toEqual(["home"]);
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
		const registry = { ...meteredBilling, getAvailable: () => available, getProvider: () => undefined } as never;
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
		const registry = { ...meteredBilling, getAvailable: () => available, getProvider: () => undefined } as never;
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
