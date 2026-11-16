import { describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as openai } from "../src/api/openai-responses.ts";
import { sdkMessages } from "../src/api/ai-sdk/messages.ts";
import type { Api, Model } from "../src/types.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { completionsResponse } from "./completions-fetch-fixture.ts";

function model<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return {
		api,
		provider,
		baseUrl: "https://proxy.invalid/v1",
		id,
		name: "Test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 4096,
	};
}
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("shared SDK reasoning", () => {
	it("sends Anthropic budgets and keeps the encrypted signature", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async () =>
			completionsResponse([
				{
					type: "message_start",
					message: {
						id: "msg_1",
						model: "claude-test",
						role: "assistant",
						type: "message",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "encrypted" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
				{ type: "message_stop" },
			]),
		);
		const result = await anthropic(model("anthropic-messages", "anthropic", "claude-test"), context, {
			apiKey: "test",
			cacheRetention: "none",
			thinkingEnabled: true,
			thinkingBudgetTokens: 2048,
			fetch: request,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "thinking", thinking: "think", thinkingSignature: "encrypted" }]);
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).thinking).toEqual({
			type: "enabled",
			budget_tokens: 2048,
			display: "summarized",
		});
	});

	it("sends Google thinking levels and retains signatures on text", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async () =>
			completionsResponse([
				{
					candidates: [
						{
							index: 0,
							content: {
								role: "model",
								parts: [
									{ text: "think", thought: true },
									{ text: "hello", thoughtSignature: "c2lnbg==" },
								],
							},
							finishReason: "STOP",
						},
					],
				},
			]),
		);
		const result = await google(model("google-generative-ai", "google", "gemini-3-pro"), context, {
			apiKey: "test",
			thinking: { enabled: true, level: "HIGH" },
			fetch: request,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "high",
		});
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "hello", textSignature: "c2lnbg==" },
		]);
	});

	it("sends OpenAI effort and summary while retaining stateless storage", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async () =>
			completionsResponse([
				{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-test" } },
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						created_at: 1,
						model: "gpt-test",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			]),
		);
		const result = await openai(model("openai-responses", "openai", "gpt-test"), context, {
			apiKey: "test",
			reasoningEffort: "high",
			reasoningSummary: "detailed",
			fetch: request,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
			store: false,
			reasoning: { effort: "high", summary: "detailed" },
		});
	});

	it("replays OpenAI encrypted reasoning and composite tool identifiers", async () => {
		const target = model("openai-responses", "openai", "gpt-test");
		const assistant = createPendingAssistantMessage(target);
		assistant.stopReason = "toolUse";
		assistant.content = [
			{
				type: "thinking",
				thinking: "think",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_1",
					encrypted_content: "encrypted",
					summary: [{ type: "summary_text", text: "think" }],
				}),
			},
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "test" } },
		];
		const replay = normalizeContext({ messages: [...context.messages, assistant] });
		const payload = vi.fn(() => {
			throw new Error("request captured");
		});
		const result = await openai(target, replay, { apiKey: "test", onPayload: payload }).result();
		expect(payload).toHaveBeenCalledOnce();
		expect(result.errorMessage).toContain("request captured");
		const message = sdkMessages(target, replay).find((message) => message.role === "assistant");
		expect(message).toMatchObject({
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "think",
					providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } },
				},
				{ type: "tool-call", toolCallId: "call_1", providerOptions: { openai: { itemId: "fc_1" } } },
			],
		});
	});
});
