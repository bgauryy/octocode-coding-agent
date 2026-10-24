import { describe, expect, it } from "vitest";
import {
	closeModels,
	type ModelRef,
	resolveModel,
	routedModel,
	routeModel,
} from "../../src/octocode/subagents/model.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";

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
