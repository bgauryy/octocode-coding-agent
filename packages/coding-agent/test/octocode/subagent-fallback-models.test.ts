import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { coerceSettingValue, findLeaf } from "../../src/configuration/settings-leaves.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { type ModelRef, routeModel } from "../../src/octocode/subagents/model.ts";
import { buildAgentArgs, buildRouteArgs } from "../../src/octocode/subagents/process/session.ts";

const SESSION = { dir: "/tmp/session", id: "child" };

const m = (provider: string, id: string, input: number, output: number): ModelRef => ({
	provider,
	id,
	cost: { input, output },
	contextWindow: 200_000,
	input: ["text", "image"],
});

// An Opus-class parent, and a cheaper model on each of four providers (the parent's own among them).
const opus = m("anthropic", "opus", 5, 25);
const haiku = m("anthropic", "haiku", 0.5, 2.5);
const mini = m("openai", "mini", 0.4, 1.6);
const kimi = m("kimi-coding", "kimi-k2", 1, 4);
const qwen = m("qwen-token-plan", "qwen-coder", 1.2, 5);
const available = [opus, haiku, mini, kimi, qwen];

const withoutLevel = (model: string) => model.replace(/:(off|minimal|low|medium|high|xhigh)$/, "");
const fallbackOf = (route: ReturnType<typeof routeModel>) =>
	("fallbackModels" in route ? route.fallbackModels : undefined)?.map(withoutLevel);

/** The `retry.fallbackModels` a child's own argument parsing and settings loader read from its arguments. */
function childFallbacks(args: string[]): unknown {
	const words = (parseArgs(args).set ?? []).filter((word) => word.startsWith("retry.fallbackModels="));
	if (words.length === 0) return undefined;
	const coerced = coerceSettingValue(findLeaf("retry.fallbackModels")!, words[0].slice(words[0].indexOf("=") + 1));
	return coerced.ok ? coerced.value : coerced.reason;
}

const registry = {
	getAvailable: () => available,
	getProviderBilling: () => "metered",
	allowsUnattendedUse: () => true,
	getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
	getCachePolicy: () => ({ options: {}, sources: {} }),
};
const ctx = { modelRegistry: registry, model: opus } as never;

describe("routed fallback models of a child", () => {
	it("lists the next routed models of other providers for a model the router chose", () => {
		const route = routeModel({ preferred: "small", available, parent: opus });
		expect(route).toMatchObject({ model: "anthropic/haiku" });
		expect(fallbackOf(route)).toEqual(["openai/mini", "kimi-coding/kimi-k2"]);
	});

	it("skips a provider marked refused, and the list holds at most two", () => {
		const refused = (provider: string) => provider === "openai";
		const route = routeModel({ preferred: "small", available, parent: opus, refused });
		expect(fallbackOf(route)).toEqual(["kimi-coding/kimi-k2", "qwen-token-plan/qwen-coder"]);
	});

	it("gives a model the caller named no list", () => {
		const route = routeModel({ explicit: "anthropic/haiku", available, parent: opus });
		expect(route).toEqual({ model: "anthropic/haiku" });
	});

	it("gives the parent's own model no list: nothing was routed", () => {
		expect(routeModel({ available, parent: opus })).toEqual({ model: "anthropic/opus" });
	});

	it("has no list when no other provider has a candidate", () => {
		expect(fallbackOf(routeModel({ preferred: "small", available: [opus, haiku], parent: opus }))).toBeUndefined();
	});

	it("puts the list in the arguments of a routed child, and none in an explicit child's", () => {
		const routed = planRun(new Map(), { model: "small" }, ctx);
		const routedArgs = buildRouteArgs(undefined, routed.route, SESSION);
		expect(childFallbacks(routedArgs)).toEqual([
			expect.stringMatching(/^openai\/mini/),
			expect.stringMatching(/^kimi-coding\/kimi-k2/),
		]);
		const named = planRun(new Map(), { model: "anthropic/haiku" }, ctx);
		const namedArgs = buildRouteArgs(undefined, named.route, SESSION);
		expect(namedArgs).not.toContain("--set");
	});

	it("passes no setting for an empty list", () => {
		expect(buildAgentArgs(undefined, "anthropic/haiku", SESSION, [], undefined, [], [])).not.toContain("--set");
	});
});
