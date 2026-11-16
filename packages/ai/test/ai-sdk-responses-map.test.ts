import { describe, expect, it } from "vitest";
import { responsesMapping } from "../src/api/ai-sdk/responses-map.ts";
import { prepareSdkRequest } from "../src/api/ai-sdk/transport.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "custom-reasoner",
	name: "Custom",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

describe("Responses SDK policy mapping", () => {
	it("maps explicit caching and effort updates without building a wire request", () => {
		const mapping = responsesMapping(
			{ ...model, compat: { supportsExplicitPromptCacheMode: true, supportsMidConvoEffort: true } },
			{
				apiKey: "sk-test",
				cacheRetention: "long",
				sessionId: "session",
				reasoningEffort: "high",
				serviceTier: "priority",
			},
		);
		expect(mapping.providerOptions.openai).toMatchObject({
			store: false,
			promptCacheKey: "session",
			promptCacheOptions: { ttl: "12h" },
			reasoningEffort: "medium",

			reasoningSummary: "auto",
			serviceTier: "priority",
		});
	});
	it("uses model effort aliases and named tool choices", () => {
		const mapping = responsesMapping(
			{ ...model, thinkingLevelMap: { high: "xhigh" } },
			{
				reasoningEffort: "high",
				toolChoice: { type: "function", name: "read" },
			},
		);
		expect(mapping.providerOptions.openai).toMatchObject({ reasoningEffort: "xhigh" });
		expect(mapping.toolChoice).toEqual({ type: "tool", toolName: "read" });
	});
	it("omits cache controls and configuration updates for ChatGPT credentials", () => {
		const mapping = responsesMapping(
			{ ...model, compat: { supportsExplicitPromptCacheMode: true, supportsMidConvoEffort: true } },
			{
				apiKey: "subscription-token",
				cacheRetention: "long",
				reasoningEffort: "high",
			},
		);
		expect(mapping.providerOptions.openai).not.toHaveProperty("promptCacheOptions");
		expect(mapping.providerOptions.openai).not.toHaveProperty("reasoningEffortUpdate");
	});
	it("allows async payload mutation and replacement while preserving fetch options", async () => {
		const init = { body: JSON.stringify({ model: "custom-reasoner" }), method: "POST" };
		const mutated = await prepareSdkRequest(
			model,
			{
				onPayload: async (body) => {
					Object.assign(body as object, { store: false });
				},
			},
			"https://example.invalid",
			init,
		);
		expect(JSON.parse(String(mutated?.body))).toEqual({ model: "custom-reasoner", store: false });
		const replaced = await prepareSdkRequest(
			model,
			{ onPayload: async () => ({ replacement: true }) },
			"https://example.invalid",
			init,
		);
		expect(replaced).toEqual({ method: "POST", body: '{"replacement":true}' });
	});
	it("surfaces payload hook errors before sending", async () => {
		await expect(
			prepareSdkRequest(
				model,
				{
					onPayload: () => {
						throw new Error("hook failed");
					},
				},
				"https://example.invalid",
				{ body: "{}" },
			),
		).rejects.toThrow("hook failed");
	});
});
