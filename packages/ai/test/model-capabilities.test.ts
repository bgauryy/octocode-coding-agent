import { describe, expect, it } from "vitest";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

function model<TApi extends Api>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...overrides,
	};
}

describe("model capabilities", () => {
	it("reports limits and input modalities from the model", () => {
		const caps = resolveModelCapabilities(model("anthropic-messages"));
		expect(caps).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 32_000, input: ["text", "image"] });
	});

	it.each([
		["Anthropic adaptive", model("anthropic-messages", { compat: { forceAdaptiveThinking: true } }), "effort"],
		["Anthropic budget", model("anthropic-messages"), "budget"],
		["Bedrock adaptive Claude", model("bedrock-converse-stream", { id: "us.anthropic.claude-opus-5-5-v1" }), "effort"],
		["Bedrock older Claude", model("bedrock-converse-stream", { id: "anthropic.claude-3-7-sonnet" }), "budget"],
		["Gemini 3 level", model("google-generative-ai", { id: "gemini-3.1-pro-preview" }), "level"],
		["Gemini 2.5 budget", model("google-generative-ai", { id: "gemini-2.5-pro" }), "budget"],
		["OpenAI Responses", model("openai-responses"), "effort"],
		["Completions with effort", model("openai-completions", { compat: { supportsReasoningEffort: true } }), "effort"],
		[
			"Completions with token budget",
			model("openai-completions", { compat: { supportsThinkingTokenBudget: true } }),
			"budget",
		],
		["non-reasoning", model("openai-responses", { reasoning: false }), "none"],
	] as const)("derives %s thinking control", (_name, input, control) => {
		expect(resolveModelCapabilities(input).thinking.control).toBe(control);
	});

	it("lists supported thinking levels and whether thinking can be turned off", () => {
		const caps = resolveModelCapabilities(
			model("anthropic-messages", { thinkingLevelMap: { off: null, xhigh: "xhigh" } }),
		);
		expect(caps.thinking.canDisable).toBe(false);
		expect(caps.thinking.levels).toContain("xhigh");
		expect(resolveModelCapabilities(model("openai-responses", { reasoning: false })).thinking).toEqual({
			control: "none",
			levels: ["off"],
			canDisable: true,
		});
	});

	it.each([
		["Anthropic", model("anthropic-messages"), "markers", { short: 300, long: 3600 }],
		[
			"Anthropic without long retention",
			model("anthropic-messages", { compat: { supportsLongCacheRetention: false } }),
			"markers",
			{ short: 300 },
		],
		[
			"Bedrock Claude",
			model("bedrock-converse-stream", { id: "us.anthropic.claude-sonnet-4-6-v1" }),
			"markers",
			{
				short: 300,
				long: 3600,
			},
		],
		["Bedrock Nova", model("bedrock-converse-stream", { id: "amazon.nova-pro-v1" }), "implicit", {}],
		[
			"OpenAI explicit mode",
			model("openai-responses", { provider: "openai", compat: { supportsExplicitPromptCacheMode: true } }),
			"explicit-breakpoint",
			{ short: 1800, long: 43_200 },
		],
		["OpenAI implicit", model("openai-responses"), "key", {}],
		[
			"OpenAI implicit with extended retention",
			model("openai-responses", { provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			"key",
			{ long: 86_400 },
		],
		[
			"OpenRouter Claude over Completions",
			model("openai-completions", { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }),
			"markers",
			{ short: 300, long: 3600 },
		],
		["Gemini", model("google-generative-ai"), "implicit", {}],
	] as const)("derives the %s cache mechanism", (_name, input, mechanism, lifetimes) => {
		expect(resolveModelCapabilities(input).cache).toEqual({ mechanism, lifetimes });
	});

	it("uses declared lifetimes, with a long tier only where the endpoint accepts it", () => {
		const declared = model("anthropic-messages", { promptCache: { short: 240, long: 1800 } });
		expect(resolveModelCapabilities(declared).cache.lifetimes).toEqual({ short: 240, long: 1800 });
		const refused = model("anthropic-messages", {
			promptCache: { short: 300, long: 3600 },
			compat: { supportsLongCacheRetention: false },
		});
		expect(resolveModelCapabilities(refused).cache.lifetimes).toEqual({ short: 300 });
		// A declared long tier on a Responses host the adapter does not send long retention to is not offered.
		const otherHost = model("openai-responses", { provider: "opencode", promptCache: { short: 300, long: 3600 } });
		expect(resolveModelCapabilities(otherHost).cache.lifetimes).toEqual({ short: 300 });
	});

	it("resolves every built-in chat model without throwing", () => {
		const models = builtinModels();
		for (const provider of models.getProviders()) {
			for (const entry of models.getModels(provider.id)) {
				const caps = resolveModelCapabilities(entry);
				expect(caps.contextWindow).toBe(entry.contextWindow);
				expect(caps.thinking.levels.length).toBeGreaterThan(0);
			}
		}
	});
});
