import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import {
	CHARS_PER_TOKEN,
	charsPerToken,
	charsToTokens,
	ESTIMATED_IMAGE_TOKENS,
	estimateContextTokens,
	estimateMessageTokens,
} from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	// Regression for #10497: large new inputs need more room than chars/4 allows. Without a model family the ratio is
	// the densest measured, 2.5 characters per token (Claude).
	it("reserves 2.5 characters per token for new text when limiting output", () => {
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: "x".repeat(3_000), timestamp: 200 }],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 3_200,
			usageTokens: 2_000,
			trailingTokens: 1_200,
			lastUsageIndex: 0,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(2_704);
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_608,
			usageTokens: 0,
			trailingTokens: 1_608,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_296);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_002,
			usageTokens: 2_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});
});

describe("characters per token by model family", () => {
	it("uses each family's measured ratio and the densest one without a family", () => {
		expect(charsPerToken({ id: "claude-opus-5-5" })).toBe(2.5);
		expect(charsPerToken({ id: "us.anthropic.claude-sonnet-5-5-v1:0" })).toBe(2.5);
		expect(charsPerToken({ id: "anthropic/claude-haiku-5.5" })).toBe(2.5);
		expect(charsPerToken({ id: "gpt-6.1-sol" })).toBe(3.5);
		expect(charsPerToken({ id: "openai/o3" })).toBe(3.5);
		expect(charsPerToken({ id: "deepseek-v4-flash" })).toBe(3.3);
		expect(charsPerToken({ id: "DeepSeek-V4-Flash", provider: "tokenlab" })).toBe(3.3);
		expect(charsPerToken({ id: "deepseek/deepseek-v3.2" })).toBe(3.3);
		expect(charsPerToken({ id: "us.deepseek.r1-v1:0" })).toBe(3.3);
		expect(charsPerToken({ id: "chat", provider: "deepseek" })).toBe(3.3);
		expect(charsPerToken({ id: "gemini-3.1-pro" })).toBe(CHARS_PER_TOKEN);
		expect(charsPerToken({ id: "gemini-3.1-pro", provider: "openrouter" })).toBe(CHARS_PER_TOKEN);
		expect(charsPerToken()).toBe(CHARS_PER_TOKEN);
		expect(charsToTokens(3500, { id: "gpt-6.1-sol" })).toBe(1000);
		expect(charsToTokens(3500)).toBe(1400);
	});

	it("estimates messages and contexts at the model's ratio, images at a fixed count", () => {
		const gpt = { id: "gpt-6.1-sol" };
		const text = { role: "user" as const, content: "x".repeat(3_500), timestamp: 1 };
		expect(estimateMessageTokens(text)).toBe(1_400);
		expect(estimateMessageTokens(text, gpt)).toBe(1_000);
		const withImage = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: "x".repeat(3_500) },
				{ type: "image" as const, data: "", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		expect(estimateMessageTokens(withImage)).toBe(1_400 + ESTIMATED_IMAGE_TOKENS);
		expect(estimateMessageTokens(withImage, gpt)).toBe(1_000 + ESTIMATED_IMAGE_TOKENS);
		expect(estimateContextTokens([text, text], gpt).tokens).toBe(2_000);
	});

	it("gives a lower bound with the sparse end of the range", () => {
		expect(charsPerToken({ id: "claude-opus-5-5" }, "floor")).toBe(2.6);
		expect(charsPerToken({ id: "gpt-6.1-sol" }, "floor")).toBe(4.9);
		expect(charsPerToken({ id: "deepseek-v4-flash" }, "floor")).toBe(4);
		expect(charsPerToken(undefined, "floor")).toBe(4.9);
	});
});
