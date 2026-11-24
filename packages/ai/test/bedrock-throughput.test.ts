import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";
import { bedrockReplyBudget } from "../src/utils/bedrock-models.ts";
import {
	bedrockOutputBurndown,
	bedrockQuotaTokens,
	estimateBedrockAdmissionTokens,
} from "../src/utils/bedrock-throughput.ts";

const kimi = getBuiltinModel("amazon-bedrock", "global.moonshotai.kimi-k3.1");
const glm = getBuiltinModel("amazon-bedrock", "global.zai.glm-5.3");
const custom: Model<Api> = {
	...kimi,
	api: "openai-completions",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
};

describe("Bedrock reply budget", () => {
	it("defaults Kimi K3.1 to 8192 and honors explicit sizes within the model cap", () => {
		expect(bedrockReplyBudget(kimi)).toBe(8192);
		expect(bedrockReplyBudget(kimi, 32768)).toBe(Math.min(32768, kimi.maxTokens));
		expect(bedrockReplyBudget({ ...kimi, maxTokens: 2048 })).toBe(2048);
		expect(bedrockReplyBudget(glm)).toBeUndefined();
	});
	it("recognizes geographic and custom Bedrock endpoints", () => {
		expect(bedrockReplyBudget({ ...kimi, id: "us.moonshotai.kimi-k3.1" })).toBe(8192);
		expect(bedrockReplyBudget(custom)).toBe(8192);
		expect(bedrockReplyBudget({ ...custom, baseUrl: "https://example.com/v1" })).toBeUndefined();
	});
});

describe("Bedrock token accounting", () => {
	const usage = { input: 100, output: 20, cacheWrite: 5, cacheRead: 9999 };
	it("burns Kimi K3.1 output at 10x and other models at 1x", () => {
		expect(bedrockOutputBurndown(kimi)).toBe(10);
		expect(bedrockOutputBurndown(custom)).toBe(10);
		expect(bedrockOutputBurndown(glm)).toBe(1);
		const mantle = { ...custom, baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1" };
		expect(bedrockReplyBudget(mantle)).toBe(8192);
		expect(bedrockOutputBurndown(mantle)).toBe(1);
	});
	it("excludes cacheRead and handles zero usage", () => {
		expect(bedrockQuotaTokens(kimi, usage)).toBe(305);
		expect(bedrockQuotaTokens(glm, usage)).toBe(125);
		expect(bedrockQuotaTokens(kimi, { input: 0, output: 0, cacheWrite: 0 })).toBe(0);
	});
	it("keeps provider admission at 1x even though Kimi's final output burndown is 10x", () => {
		expect(estimateBedrockAdmissionTokens(1000, 8192)).toBe(9192);
		expect(bedrockQuotaTokens(kimi, { input: 1000, cacheWrite: 0, output: 8192 })).toBe(82920);
		expect(estimateBedrockAdmissionTokens(0, 0)).toBe(0);
	});
});
