import { describe, expect, it } from "vitest";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { builtinModels } from "../src/providers/all.ts";
import { withCacheCapabilities } from "../src/utils/cache-capabilities.ts";
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
		["Bedrock Nova effort", model("bedrock-converse-stream", { id: "amazon.nova-2-lite-v1:0" }), "effort"],
		["Bedrock older Claude", model("bedrock-converse-stream", { id: "anthropic.claude-3-7-sonnet" }), "budget"],
		["Gemini 3 level", model("google-generative-ai", { id: "gemini-3.1-pro-preview" }), "level"],
		["Gemini 2.5 budget", model("google-generative-ai", { id: "gemini-2.5-pro" }), "budget"],
		["OpenAI Responses", model("openai-responses"), "effort"],
		["Completions with effort", model("openai-completions", { compat: { supportsReasoningEffort: true } }), "effort"],
		[
			"Completions with token budget",
			model("openai-completions", { compat: { thinkingTokenBudgetField: "thinking_token_budget" } }),
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
		[
			"Anthropic",
			model("anthropic-messages", { baseUrl: "https://api.anthropic.com" }),
			"markers",
			{ short: 300, long: 3600 },
		],
		["Anthropic-compatible gateway", model("anthropic-messages"), "markers", { short: 300 }],
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
		["Bedrock Nova", model("bedrock-converse-stream", { id: "amazon.nova-pro-v1" }), "markers", { short: 300 }],
		["Bedrock Nova Premier", model("bedrock-converse-stream", { id: "us.amazon.nova-premier-v1:0" }), "implicit", {}],
		[
			"OpenAI explicit mode",
			model("openai-responses", { provider: "openai", compat: { supportsExplicitPromptCacheMode: true } }),
			"explicit-breakpoint",
			{ short: 1800, long: 43_200 },
		],
		["OpenAI implicit", model("openai-responses"), "key", {}],
		[
			"OpenAI implicit with extended retention",
			withCacheCapabilities(
				model("openai-responses", { id: "gpt-4.1", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			),
			"key",
			{ long: 1800 },
		],
		[
			"OpenRouter Claude over Completions",
			model("openai-completions", { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }),
			"markers",
			{ short: 300, long: 3600 },
		],
		[
			"OpenRouter Claude over Messages",
			model("anthropic-messages", {
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api",
				id: "anthropic/claude-sonnet-5.5",
			}),
			"markers",
			{ short: 300, long: 3600 },
		],
		[
			"OpenRouter non-Claude over Messages",
			model("anthropic-messages", { provider: "openrouter", baseUrl: "https://openrouter.ai/api", id: "z-ai/glm-5" }),
			"markers",
			{ short: 300 },
		],
		[
			"Vercel AI Gateway Claude",
			model("anthropic-messages", {
				provider: "vercel-ai-gateway",
				baseUrl: "https://ai-gateway.vercel.sh",
				id: "anthropic/claude-sonnet-5.5",
			}),
			"markers",
			{ short: 300 },
		],
		[
			"Vercel AI Gateway OpenAI upstream",
			model("anthropic-messages", {
				provider: "vercel-ai-gateway",
				baseUrl: "https://ai-gateway.vercel.sh",
				id: "openai/gpt-5",
			}),
			"implicit",
			{},
		],
		["Gemini", model("google-generative-ai"), "implicit", {}],
	] as const)("derives the %s cache mechanism", (_name, input, mechanism, lifetimes) => {
		const cache = resolveModelCapabilities(input).cache;
		expect(cache.mechanism).toBe(mechanism);
		expect(cache.lifetimes).toEqual(lifetimes);
	});

	it("keeps OpenAI explicit-mode history at the request's 30m: the 12h tier is for instruction breakpoints", () => {
		const explicit = model("openai-responses", {
			provider: "openai",
			compat: { supportsExplicitPromptCacheMode: true },
		});
		expect(resolveModelCapabilities(explicit).cache.longInstructionsOnly).toBe(true);
		// Azure breakpoints take no ttl, so its request TTL carries the long tier for the history too.
		const azure = model("azure-openai-responses", { compat: { supportsExplicitPromptCacheMode: true } });
		expect(resolveModelCapabilities(azure).cache.longInstructionsOnly).toBeUndefined();
		expect(resolveModelCapabilities(model("anthropic-messages")).cache.longInstructionsOnly).toBeUndefined();
	});

	it("plans 24h extended retention at its typical 30 minutes, with 24h as the upper bound", () => {
		const extended = withCacheCapabilities(
			model("openai-responses", { id: "gpt-4.1", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
		);
		expect(resolveModelCapabilities(extended).cache).toEqual({
			mechanism: "key",
			lifetimes: { long: 1800 },
			longUpTo: 86_400,
		});
	});

	it("uses declared lifetimes, with a long tier only where the endpoint accepts it", () => {
		const declared = model("anthropic-messages", {
			baseUrl: "https://api.anthropic.com",
			promptCache: { short: 240, long: 1800 },
		});
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
				const managed =
					entry.reasoning &&
					(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).every(
						(level) => entry.thinkingLevelMap?.[level] === null,
					);
				if (managed) {
					expect(caps.thinking, `${entry.provider}/${entry.id}`).toEqual({
						control: "managed",
						levels: [],
						canDisable: false,
					});
				} else {
					expect(caps.thinking.levels.length, `${entry.provider}/${entry.id}`).toBeGreaterThan(0);
					expect(caps.thinking.control).not.toBe("managed");
				}
			}
		}
	});
});
