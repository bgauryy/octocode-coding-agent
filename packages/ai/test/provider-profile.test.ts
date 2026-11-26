import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { getCompat } from "../src/api/openai-completions/compat.ts";
import { getAnthropicCompat } from "../src/api/anthropic-messages/compat.ts";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { resolveProviderProfile } from "../src/utils/provider-profile.ts";
import { clampThinkingLevel, effortLevel, effortValue } from "../src/models/thinking.ts";
import {
	bodyAfterRejection,
	clearRejectedCapabilities,
	isCapabilityRejected,
	rejectedCapabilityFromError,
	withoutRejectedCapabilities,
} from "../src/utils/rejected-capabilities.ts";

function model<T extends Api>(api: T, fields: Partial<Model<T>>): Model<T> {
	return {
		id: "m",
		name: "m",
		api,
		provider: "custom",
		baseUrl: "https://gw.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...fields,
	};
}

describe("profile detection without a declared profile", () => {
	it.each([
		["openrouter", "https://x.example/v1", "openrouter"],
		["custom", "https://openrouter.ai/api/v1", "openrouter"],
		["custom", "https://api.deepseek.com/v1", "deepseek"],
		["custom", "https://proxy.example/openrouter.ai/v1", undefined],
		["custom", "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", "bedrock"],
	])("%s at %s is %s", (provider, baseUrl, expected) => {
		expect(resolveProviderProfile({ provider, baseUrl })).toBe(expected);
	});

	it("keeps the host-bound facts of OpenAI and Anthropic on their own endpoints", () => {
		expect(resolveProviderProfile({ provider: "openai", baseUrl: "https://proxy.example/v1" }, "host")).toBeUndefined();
		expect(resolveProviderProfile({ provider: "x", baseUrl: "https://api.openai.com/v1" }, "host")).toBe("openai");
	});

	it("detects the same Chat Completions quirks the host checks did", () => {
		const deepseek = getCompat(model("openai-completions", { baseUrl: "https://api.deepseek.com/v1" }));
		expect(deepseek).toMatchObject({
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
			supportsStore: false,
			requiresReasoningContentOnAssistantMessages: true,
		});
		const plain = getCompat(model("openai-completions", {}));
		expect(plain).toMatchObject({ supportsStore: true, thinkingFormat: "openai", cacheControlFormat: undefined });
	});
});

describe("declared profile", () => {
	it("gives a Chat Completions gateway Claude markers and the 1h tier", () => {
		const plain = getCompat(model("openai-completions", {}));
		const declared = getCompat(model("openai-completions", { profile: "anthropic" }));
		expect(plain.cacheControlFormat).toBeUndefined();
		expect(declared.cacheControlFormat).toBe("anthropic");
		expect(declared.supportsLongCacheRetention).toBe(true);
	});

	it("gives an Anthropic-protocol gateway the Anthropic markers and long tier", () => {
		const gateway = model("anthropic-messages", { baseUrl: "https://ai-gateway.vercel.sh", id: "team/claude" });
		expect(resolveModelCapabilities(gateway).cache.mechanism).toBe("implicit");
		const declared = { ...gateway, profile: "anthropic" as const };
		expect(resolveModelCapabilities(declared).cache.mechanism).toBe("markers");
		expect(getAnthropicCompat(declared).supportsLongCacheRetention).toBe(true);
	});

	it("lets an explicit compat value win over the profile", () => {
		const declared = model("openai-completions", {
			profile: "anthropic",
			compat: { cacheControlFormat: undefined, supportsLongCacheRetention: false },
		});
		expect(getCompat(declared).supportsLongCacheRetention).toBe(false);
	});
});

describe("rejected capabilities", () => {
	afterEach(() => clearRejectedCapabilities());
	const target = { baseUrl: "https://gw.example/v1/", id: "claude" };
	const body = JSON.stringify({
		system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "t", strict: true }],
		output_config: { effort: "high" },
	});

	it("classifies a 400 that names the field, and nothing else", () => {
		expect(rejectedCapabilityFromError(400, "system.0.cache_control: Extra inputs are not permitted")).toBe(
			"cache_control",
		);
		expect(rejectedCapabilityFromError(400, "tools.0.strict: Extra inputs are not permitted")).toBe("strict_tools");
		expect(rejectedCapabilityFromError(400, "Unknown parameter: reasoning_effort")).toBe("effort");
		expect(rejectedCapabilityFromError(500, "cache_control: Extra inputs")).toBeUndefined();
		expect(rejectedCapabilityFromError(400, "max_tokens must be positive")).toBeUndefined();
	});

	it.each([
		"strict mode JSON parse error",
		"Invalid value for effort: 'ultra'",
		"max_tokens must be greater than the thinking budget",
		"Unsupported value: temperature is not permitted with this model",
		"invalid request: tool input is not strict JSON",
	])("leaves an unrelated 400 alone: %s", (message) => {
		expect(rejectedCapabilityFromError(400, message)).toBeUndefined();
		expect(bodyAfterRejection(target, body, 400, message)).toBeUndefined();
		expect(withoutRejectedCapabilities(target, body)).toBe(body);
	});

	it.each([
		["tools.0.custom.strict: Extra inputs are not permitted", "strict_tools"],
		["Unknown parameter: 'tools[0].function.strict'", "strict_tools"],
		["Unrecognized request argument supplied: reasoning.effort", "effort"],
		["output_config.effort: Extra inputs are not permitted", "effort"],
		["thinking: Extra inputs are not permitted", "thinking"],
		["Unknown parameter: 'thinking'", "thinking"],
		["extraneous key [cachePoint] is not permitted", "cache_control"],
	])("names the field as providers write it: %s", (message, expected) => {
		expect(rejectedCapabilityFromError(400, message)).toBe(expected);
	});

	it("strips only the effort field when an effort is refused, and thinking only when it is named", () => {
		const request = JSON.stringify({
			thinking: { type: "adaptive" },
			output_config: { effort: "high", format: { type: "json" } },
			additionalModelRequestFields: { reasoning_effort: "low", reasoningConfig: { type: "enabled" } },
		});
		const effort = JSON.parse(
			bodyAfterRejection(target, request, 400, "output_config.effort: Extra inputs are not permitted")!,
		);
		expect(effort.thinking).toEqual({ type: "adaptive" });
		expect(effort.output_config).toEqual({ format: { type: "json" } });
		expect(effort.additionalModelRequestFields.reasoning_effort).toBeUndefined();
		expect(effort.additionalModelRequestFields.reasoningConfig).toBeDefined();
		clearRejectedCapabilities();
		const thinking = JSON.parse(bodyAfterRejection(target, request, 400, "thinking: Extra inputs are not permitted")!);
		expect(thinking.thinking).toBeUndefined();
		expect(thinking.output_config.effort).toBe("high");
	});

	it("resends once without the rejected field and then stops sending it", () => {
		const resend = bodyAfterRejection(target, body, 400, "cache_control: Extra inputs are not permitted");
		expect(resend).toBeDefined();
		expect(JSON.parse(resend!).system[0]).not.toHaveProperty("cache_control");
		expect(JSON.parse(resend!).tools[0].strict).toBe(true);
		expect(isCapabilityRejected({ baseUrl: "https://gw.example/v1", id: "claude" }, "cache_control")).toBe(true);
		expect(JSON.parse(withoutRejectedCapabilities(target, body)).system[0]).not.toHaveProperty("cache_control");
		// A second identical rejection after the field was dropped is not a reason to resend.
		expect(bodyAfterRejection(target, resend!, 400, "cache_control: Extra inputs are not permitted")).toBeUndefined();
	});

	it("is per endpoint and model", () => {
		bodyAfterRejection(target, body, 400, "cache_control: Extra inputs are not permitted");
		expect(withoutRejectedCapabilities({ ...target, id: "other" }, body)).toBe(body);
	});

	it("bounds its memory", () => {
		for (let index = 0; index < 300; index++)
			bodyAfterRejection({ baseUrl: "https://gw.example", id: `m${index}` }, body, 400, "cache_control: Extra inputs");
		expect(isCapabilityRejected({ baseUrl: "https://gw.example", id: "m0" }, "cache_control")).toBe(false);
		expect(isCapabilityRejected({ baseUrl: "https://gw.example", id: "m299" }, "cache_control")).toBe(true);
	});
});

describe("thinking clamp", () => {
	const levels = model("openai-completions", {
		thinkingLevelMap: { minimal: null, low: "lo", medium: null, high: "hi", xhigh: null },
	});

	it("keeps a supported level and maps it through the alias", () => {
		expect(clampThinkingLevel(levels, "low")).toBe("low");
		expect(effortValue(levels, "low")).toBe("lo");
	});

	it("takes the nearest lower level for an unsupported one", () => {
		expect(clampThinkingLevel(levels, "medium")).toBe("low");
		expect(effortLevel(levels, "xhigh")).toBe("high");
		expect(effortValue(levels, "medium")).toBe("lo");
	});

	it("sends no effort at all when the map leaves no level to think at", () => {
		const none = model("openai-completions", {
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		});
		expect(effortLevel(none, "high")).toBeUndefined();
		expect(effortValue(none, "high")).toBeUndefined();
	});

	it("takes the lowest supported level when nothing is lower, never off for a request to think", () => {
		expect(clampThinkingLevel(levels, "minimal")).toBe("low");
		expect(effortValue(levels, "minimal")).toBe("lo");
	});
});
