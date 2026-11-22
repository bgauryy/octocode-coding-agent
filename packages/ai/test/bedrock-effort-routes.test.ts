import { beforeEach, describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models/model-helpers.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { streamSimple as completions } from "../src/api/openai-completions.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import { streamSimple as converse } from "../src/api/bedrock-converse-stream.ts";
import type { SimpleStreamOptions } from "../src/types.ts";
import { bedrockContext, bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";

const host = "https://bedrock-runtime.us-east-1.amazonaws.com";
const kimi = getBuiltinModel("amazon-bedrock", "global.moonshotai.kimi-k3.1");
const glm = getBuiltinModel("amazon-bedrock", "global.zai.glm-5.3");

describe("Bedrock reasoning and output budget on the wire", () => {
	let payload: Record<string, any>;
	beforeEach(() => {
		payload = {};
	});
	const capture: typeof fetch = async (_url, init) => {
		payload = JSON.parse(String(init?.body));
		// No generation is needed to inspect the request body observed by fetch.
		return new Response('{"error":{"message":"fixture"}}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	};

	it.each(["openai-completions", "openai-responses", "bedrock-converse-stream"] as const)(
		"sends documented effort and limit on %s",
		async (api) => {
			for (const [model, reasoning, expected] of [
				[kimi, undefined, "none"],
				[kimi, "minimal", "low"],
				[kimi, "max", "max"],
				[glm, undefined, "low"],
				[glm, "minimal", "low"],
				[glm, "xhigh", "xhigh"],
			] as const) {
				const options: SimpleStreamOptions = { apiKey: "fixture", reasoning, fetch: capture };
				const remote = { ...model, provider: "custom-bedrock", baseUrl: host + "/openai/v1" };
				if (api === "openai-completions") await completions({ ...remote, api }, bedrockContext, options).result();
				else if (api === "openai-responses") await responses({ ...remote, api }, bedrockContext, options).result();
				else await converse(model, bedrockContext, options).result();
				const effort =
					api === "openai-completions"
						? payload.reasoning_effort
						: api === "openai-responses"
							? payload.reasoning?.effort
							: payload.additionalModelRequestFields?.reasoning_effort;
				expect.soft(effort, `${model.id}/${reasoning ?? "off"}`).toBe(expected);
				if (model.id === kimi.id)
					expect
						.soft(
							payload.inferenceConfig?.maxTokens ??
								payload.max_completion_tokens ??
								payload.max_tokens ??
								payload.max_output_tokens,
						)
						.toBe(16384);
			}
		},
	);

	it("honors an explicit reply size within Kimi's configured output ceiling", async () => {
		for (const [cap, requested, expected] of [
			[131072, 32768, 32768],
			[131072, 200000, 131072],
			[2048, undefined, 2048],
		] as const) {
			await converse({ ...kimi, maxTokens: cap }, bedrockContext, {
				apiKey: "fixture",
				maxTokens: requested,
				fetch: async (_url, init) => {
					payload = JSON.parse(String(init?.body));
					return bedrockResponse(bedrockTextEvents);
				},
			}).result();
			expect(payload.inferenceConfig.maxTokens).toBe(expected);
		}
	});

	it("removes incompatible sampling options at high Nova 2 effort and retains temperature at low effort", async () => {
		const model = getBuiltinModel("amazon-bedrock", "us.amazon.nova-2-lite-v1:0");
		for (const reasoning of ["low", "high"] as const) {
			await converse(model, bedrockContext, {
				apiKey: "fixture",
				reasoning,
				temperature: 0.7,
				samplingParams: { topP: 0.9, topK: 12 },
				fetch: capture,
			}).result();
			expect(payload.additionalModelRequestFields?.reasoningConfig?.maxReasoningEffort).toBe(reasoning);
			if (reasoning === "low") expect(payload.inferenceConfig.temperature).toBe(0.7);
			else {
				expect(payload.inferenceConfig).not.toHaveProperty("temperature");
				expect(payload.inferenceConfig).not.toHaveProperty("topP");
				expect(payload.additionalModelRequestFields).not.toHaveProperty("topK");
			}
		}
	});

	it.each(["qwen.qwen3-32b-v1:0", "deepseek.v3.2"] as const)(
		"offers provider-managed reasoning for %s on Converse",
		(id) => {
			expect(getSupportedThinkingLevels(getBuiltinModel("amazon-bedrock", id))).toEqual([]);
		},
	);
});
