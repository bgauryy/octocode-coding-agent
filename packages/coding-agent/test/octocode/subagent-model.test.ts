import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import {
	closeModels,
	type ModelRef,
	resolveModel,
	routedModel,
	routeModel,
	SUBAGENT_THINKING_ENV,
	subagentThinking,
} from "../../src/octocode/subagents/model.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { meteredBilling } from "./fake-host.ts";

const SESSION = { dir: "/s/session", id: "inky-kraken" };

const available: ModelRef[] = [
	{ provider: "openai", id: "gpt-5" },
	{ provider: "anthropic", id: "claude-sonnet-5-5" },
	{ provider: "openrouter", id: "claude-sonnet-5-5" },
	{ provider: "openrouter", id: "anthropic/claude-haiku-5-5" },
	{ provider: "openrouter", id: "qwen/qwen3:free" },
];

describe("routeModel", () => {
	it("prefers the parent provider for a bare id, else any provider that has it", () => {
		expect(
			routeModel({
				preferred: "claude-sonnet-5-5",
				available,
				parent: { provider: "openrouter", id: "parent-model" },
			}),
		).toEqual({ model: "openrouter/claude-sonnet-5-5" });
		expect(
			routeModel({
				preferred: "claude-sonnet-5-5",
				available,
				parent: { provider: "anthropic", id: "parent-model" },
			}),
		).toEqual({ model: "anthropic/claude-sonnet-5-5" });
		// The parent's provider lacks it: the first available provider with that id.
		expect(
			routeModel({ preferred: "claude-sonnet-5-5", available, parent: { provider: "openai", id: "parent-model" } }),
		).toEqual({ model: "anthropic/claude-sonnet-5-5" });
		expect(routeModel({ preferred: "gpt-5", available })).toEqual({ model: "openai/gpt-5" });
	});

	it("accepts provider/id, including ids that contain a slash or a colon", () => {
		expect(
			routeModel({ preferred: "openai/gpt-5", available, parent: { provider: "anthropic", id: "parent-model" } }),
		).toEqual({ model: "openai/gpt-5" });
		expect(routeModel({ preferred: "openrouter/anthropic/claude-haiku-5-5", available })).toEqual({
			model: "openrouter/anthropic/claude-haiku-5-5",
		});
		// A bare id holding a slash is still a bare id.
		expect(routeModel({ preferred: "anthropic/claude-haiku-5-5", available })).toEqual({
			model: "openrouter/anthropic/claude-haiku-5-5",
		});
		expect(routeModel({ preferred: "qwen/qwen3:free", available })).toEqual({ model: "openrouter/qwen/qwen3:free" });
	});

	it("keeps a :thinking suffix on the resolved id", () => {
		expect(
			routeModel({
				preferred: "claude-sonnet-5-5:high",
				available,
				parent: { provider: "anthropic", id: "parent-model" },
			}),
		).toEqual({ model: "anthropic/claude-sonnet-5-5:high" });
		expect(routeModel({ explicit: "openai/gpt-5:xhigh", available })).toEqual({ model: "openai/gpt-5:xhigh" });
		// An unknown suffix is part of the id, so nothing matches.
		expect(resolveModel("gpt-5:turbo", available, undefined)).toBeUndefined();
	});

	it("falls back to the parent's model when the profile's preference is unavailable", () => {
		expect(
			routeModel({ preferred: "claude-haiku-5-5", available, parent: { provider: "openai", id: "parent-model" } }),
		).toEqual({ model: "openai/parent-model", fallback: "claude-haiku-5-5" });
		expect(routeModel({ preferred: "claude-haiku-5-5", available: [] })).toEqual({ fallback: "claude-haiku-5-5" });
		// No preference: the child is pinned to the parent's current model, not Octocode's default.
		expect(routeModel({ available, parent: { provider: "openai", id: "gpt-5" } })).toEqual({ model: "openai/gpt-5" });
		expect(routeModel({ available })).toEqual({});
	});

	it("refuses an unavailable explicit model with the close available ids, and wins over the profile", () => {
		const route = routeModel({ explicit: "claude-sonnet-5", preferred: "gpt-5", available });
		expect(route).toEqual({
			error: expect.stringMatching(
				/^Model "claude-sonnet-5" is not available\. Close matches: .*anthropic\/claude-sonnet-5-5, openrouter\/claude-sonnet-5-5/,
			),
		});
		expect(routeModel({ explicit: "gpt-5", preferred: "claude-sonnet-5-5", available })).toEqual({
			model: "openai/gpt-5",
		});
		expect(routeModel({ explicit: "zzz", available })).toEqual({
			error: expect.stringContaining("Available: openai/gpt-5, anthropic/claude-sonnet-5-5"),
		});
		expect(routeModel({ explicit: "zzz", available: [] })).toEqual({
			error: 'Model "zzz" is not available. No models are configured',
		});
	});

	it("ranks close ids by shared name parts and caps the list", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ provider: "p", id: `claude-x-${i}` }));
		expect(closeModels("claude-sonnet", many)).toHaveLength(8);
		expect(closeModels("gpt-5", available)[0]).toBe("openai/gpt-5");
	});
});

describe("subagent thinking", () => {
	const parent: ModelRef = { provider: "p", id: "big", cost: { input: 10, output: 40 } };
	const tiers: ModelRef[] = [
		parent,
		{ provider: "p", id: "mid", cost: { input: 4, output: 16 } },
		{ provider: "p", id: "tiny", cost: { input: 0.1, output: 0.4 } },
	];
	afterEach(() => vi.unstubAllEnvs());

	it("takes the call's suffix, else the profile's, else the default, else none", () => {
		const route = (explicit: string | undefined, preferred: string | undefined, thinking?: string) =>
			routeModel({ explicit, preferred, available: tiers, parent, thinking });
		expect(route("small:high", "small:low", "minimal")).toEqual({ model: "p/tiny:high" });
		// The role's effort holds when the call picks another model without a level.
		expect(route("medium", "small:low", "minimal")).toEqual({ model: "p/mid:low" });
		expect(route(undefined, "small", "minimal")).toEqual({ model: "p/tiny:minimal" });
		// No profile: the parent's model, still not the parent's level.
		expect(route(undefined, undefined, "low")).toEqual({ model: "p/big:low" });
		expect(route(undefined, undefined)).toEqual({ model: "p/big" });
		// A preference that falls back keeps its level on the parent's model.
		expect(route(undefined, "x/gone:low")).toEqual({ model: "p/big:low", fallback: "x/gone:low" });
		// A colon that is not a level stays part of the id.
		expect(routeModel({ preferred: "qwen/qwen3:free", available, thinking: "low" })).toEqual({
			model: "openrouter/qwen/qwen3:free:low",
		});
		expect(route("zzz", "small:low")).toHaveProperty("error");
	});

	it("reads OCTOCODE_SUBAGENT_THINKING, else medium, and ignores what is not a level", () => {
		expect(subagentThinking({ [SUBAGENT_THINKING_ENV]: " LOW " })).toBe("low");
		expect(subagentThinking({ [SUBAGENT_THINKING_ENV]: "cheap" })).toBe("medium");
		expect(subagentThinking({})).toBe("medium");
	});

	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "octocode-thinking-"));
	const plan = (models: readonly object[]) => {
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		const registry = { ...meteredBilling, getAvailable: () => models, getProvider: () => undefined } as never;
		const ctx = { modelRegistry: registry, model: parent as never };
		return (profile?: string, call?: string) => planRun(profiles, { profile, model: call }, ctx).route.model;
	};
	const reasoning = tiers.map((model) => ({ ...model, reasoning: true }));

	it("names a level on every route, so the coordinator knows each child's effort, whatever its own", () => {
		const model = plan(reasoning);
		expect(model("researcher")).toBe("p/tiny:medium");
		expect(model("browser")).toBe("p/tiny:low");
		expect(model("lean")).toBe("p/tiny:low");
		expect(model("implementer")).toBe("p/mid:medium");
		expect(model("reviewer")).toBe("p/mid:medium");
		// No profile, no level: the medium purpose at the subagent default, not the coordinator's model or its high.
		expect(model(undefined)).toBe("p/mid:medium");
		vi.stubEnv(SUBAGENT_THINKING_ENV, "low");
		expect(model(undefined)).toBe("p/mid:low");
		expect(model("reviewer")).toBe("p/mid:medium");
	});

	it("routes each task by the call: lookups cheap, escalations and root causes strong", () => {
		const model = plan(reasoning);
		// A one-off lookup without a profile.
		expect(model(undefined, "small:low")).toBe("p/tiny:low");
		// A scout whose question turned out hard: the same role on a stronger route.
		expect(model("researcher", "medium:high")).toBe("p/mid:high");
		// The role's effort holds when the call only changes the model.
		expect(model("reviewer", "small")).toBe("p/tiny:medium");
		// A root cause or a design decision on the coordinator's own model.
		expect(model(undefined, "p/big:high")).toBe("p/big:high");
	});

	it("lets a model argument's :off beat the profile's level, and says when the model cannot turn thinking off", () => {
		const model = plan(reasoning);
		// `lean` is small:low; the call's own suffix wins.
		expect(model("lean", "p/tiny:off")).toBe("p/tiny:off");
		// A model whose catalog has no `off` runs at the level it supports; the route says so.
		const noOff = reasoning.map((entry) => ({ ...entry, thinkingLevelMap: { off: null } }));
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		const ctx = {
			modelRegistry: { ...meteredBilling, getAvailable: () => noOff, getProvider: () => undefined } as never,
			model: parent as never,
		};
		const route = planRun(profiles, { profile: "lean", model: "p/tiny:off" }, ctx).route;
		expect(route.model).toBe("p/tiny:minimal");
		expect(route.via).toBe("model argument: p/tiny:off; asked off; this model does not support off");
	});

	it("routes a task without a profile or model to the medium purpose, and a profile without a model to the parent's", () => {
		const ctx = (models: readonly object[]) => ({
			modelRegistry: { ...meteredBilling, getAvailable: () => models, getProvider: () => undefined } as never,
			model: parent as never,
		});
		const profiles = new Map([["plain", { name: "plain", description: "", prompt: "" }]]);
		// The route says what chose it, so the coordinator sees why the child is not on its own model.
		expect(planRun(profiles, {}, ctx(reasoning)).route).toMatchObject({
			model: "p/mid:medium",
			via: "default: medium",
		});
		// A profile without a model (a plugin agent's `model: inherit`) keeps the parent's.
		const plain = planRun(profiles, { profile: "plain" }, ctx(reasoning)).route;
		expect(plain.model).toBe("p/big:medium");
		expect(plain).not.toHaveProperty("via");
		// No capable model in the medium band: the parent's model, with no default label.
		const alone = planRun(profiles, {}, ctx(reasoning.filter((model) => model.id !== "mid"))).route;
		expect(alone.model).toBe("p/big:medium");
		expect(alone).not.toHaveProperty("via");
	});

	it("reports the level the child will really run at", () => {
		// The small model has no reasoning: its session runs at off, and the route says so.
		const model = plan(reasoning.map((entry) => (entry.id === "tiny" ? { ...entry, reasoning: false } : entry)));
		expect(model("researcher")).toBe("p/tiny:off");
		expect(model("implementer")).toBe("p/mid:medium");
	});
});

describe("buildAgentArgs model", () => {
	it("passes the resolved model, and never the profile's own unresolved preference", () => {
		const profile = { name: "p", description: "", prompt: "", model: "claude-haiku-5-5" };
		const model = (args: string[]) => args[args.indexOf("--model") + 1];
		expect(model(buildAgentArgs(profile, "anthropic/claude-haiku-5-5:low", SESSION))).toBe(
			"anthropic/claude-haiku-5-5:low",
		);
		expect(buildAgentArgs(profile, undefined, SESSION)).not.toContain("--model");
	});
});

describe("routedModel", () => {
	it("finds the model a route names, with or without a thinking suffix", () => {
		expect(routedModel("anthropic/claude-sonnet-5-5", available)).toBe(available[1]);
		expect(routedModel("openrouter/anthropic/claude-haiku-5-5:high", available)).toBe(available[3]);
		// A colon that is not a thinking level belongs to the id.
		expect(routedModel("openrouter/qwen/qwen3:free", available)).toBe(available[4]);
	});

	it("is undefined for no route or a model the registry does not list", () => {
		expect(routedModel(undefined, available)).toBeUndefined();
		expect(routedModel("anthropic/claude-opus-5-5", available)).toBeUndefined();
	});
});

describe("a child whose session has no model", () => {
	it("routeModel still names the level it runs at, in place of a model suffix", () => {
		expect(routeModel({ available, thinking: "medium" })).toEqual({ thinking: "medium" });
		// A purpose's level, a profile's level and the default, in that order.
		expect(routeModel({ explicit: "small:high", available, thinking: "medium" })).toEqual({ thinking: "high" });
		expect(routeModel({ preferred: "small:low", available, thinking: "medium" })).toEqual({ thinking: "low" });
		expect(routeModel({ preferred: "small", available, thinking: "medium" })).toEqual({ thinking: "medium" });
		expect(routeModel({ available })).toEqual({});
	});

	it("keeps the level on the route a run is planned with, and starts the child with --thinking", () => {
		const registry = { ...meteredBilling, getAvailable: () => available } as never;
		const plan = planRun(new Map(), {}, { modelRegistry: registry, model: undefined });
		expect(plan.route.model).toBeUndefined();
		expect(plan.route).toMatchObject({ thinking: subagentThinking({}) });
		const args = buildAgentArgs(undefined, plan.route.model, SESSION, [], plan.route.thinking);
		expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual(["--thinking", "medium"]);
		// A model route carries its level in the suffix: no separate flag.
		expect(buildAgentArgs(undefined, "openai/gpt-5:low", SESSION, [], "low")).not.toContain("--thinking");
	});
});
