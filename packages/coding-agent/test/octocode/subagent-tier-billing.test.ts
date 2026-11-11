import { describe, expect, it } from "vitest";
import { type ModelRef, registryBilling, resolveTier, routeModel } from "../../src/octocode/subagents/model.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";

const m = (provider: string, id: string, input: number, output: number): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
	input: ["text", "image"],
});

// An Opus-class parent on a metered key; a pricier metered coder of its own provider; a plan-billed coder elsewhere.
const opus = m("anthropic", "opus", 5, 25);
const sonnet = m("anthropic", "sonnet", 3, 15);
const haiku = m("anthropic", "haiku", 0.5, 2.5);
const kimi = m("kimi-coding", "kimi-k2", 1, 4);
const qwen = m("qwen-token-plan", "qwen-coder", 1.2, 5);
const plans = new Set(["kimi-coding", "qwen-token-plan"]);
const billing = (extra: { background?: boolean; unattended?: (provider: string) => boolean } = {}) => ({
	plan: (provider: string) => plans.has(provider),
	...extra,
});

describe("purposes and the user's plans", () => {
	it("medium prefers a capable plan-billed model over a pricier metered one; without the facts nothing changes", () => {
		const available = [opus, sonnet, haiku, kimi];
		expect(resolveTier("medium", available, opus)).toBe(sonnet);
		expect(resolveTier("medium", available, opus, undefined, billing())).toBe(kimi);
	});

	it("small takes the plan's cheapest capable model, even over a cheaper metered one", () => {
		expect(resolveTier("small", [opus, haiku, kimi], opus)).toBe(haiku);
		expect(resolveTier("small", [opus, haiku, kimi], opus, undefined, billing())).toBe(kimi);
	});

	it("a plan model costs nothing more, so it qualifies even when its list price is above the parent's", () => {
		const cheapParent = m("openai", "mini", 0.4, 1.6);
		expect(resolveTier("small", [cheapParent, kimi], cheapParent)).toBeUndefined();
		expect(resolveTier("small", [cheapParent, kimi], cheapParent, undefined, billing())).toBe(kimi);
	});

	it("a background child skips a plan that forbids unattended use; a foreground one may use it", () => {
		const unattended = (provider: string) => provider !== "qwen-token-plan";
		const available = [opus, sonnet, qwen];
		expect(resolveTier("medium", available, opus, undefined, billing({ unattended }))).toBe(qwen);
		expect(resolveTier("medium", available, opus, undefined, billing({ unattended, background: true }))).toBe(sonnet);
	});

	it("does not route a background child to the parent's own plan automatically when it forbids unattended use", () => {
		const parent = qwen;
		const route = routeModel({
			preferred: "medium",
			available: [qwen],
			parent,
			billing: billing({ unattended: () => false, background: true }),
		});
		expect(route).toEqual({ error: expect.stringMatching(/does not allow unattended use.*Name a model/) });
		// Named on purpose, it runs.
		expect(
			routeModel({
				explicit: "qwen-token-plan/qwen-coder",
				available: [qwen],
				parent,
				billing: billing({ unattended: () => false, background: true }),
			}),
		).toEqual({
			model: "qwen-token-plan/qwen-coder",
		});
	});

	it("reads the registry's billing facts when a task is planned", () => {
		const registry = {
			getAvailable: () => [opus, sonnet, kimi],
			getProviderBilling: (provider: string) => (plans.has(provider) ? "plan" : "metered"),
			allowsUnattendedUse: () => true,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			getCachePolicy: () => ({ options: {}, sources: {} }),
		};
		const plan = planRun(new Map(), { model: "medium" }, { modelRegistry: registry, model: opus } as never);
		expect(plan.route.model).toMatch(/^kimi-coding\/kimi-k2/);
		expect(registryBilling(undefined).plan?.("kimi-coding")).toBe(false);
	});
});
