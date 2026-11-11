import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { handleAnthropicStreamEvent } from "../src/api/anthropic-messages/stream-events.ts";
import { createCompletionsChunkProcessor } from "../src/api/openai-completions/stream-events.ts";
import { consumeChatStream } from "../src/api/mistral-conversations/stream-events.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared/stream-processing.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const pricing = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };

describe("usage of a dropped stream", () => {
	describe("Anthropic", () => {
		const model = { id: "mock", provider: "anthropic", cost: pricing } as unknown as Model<"anthropic-messages">;
		const start = {
			type: "message_start",
			message: { model: "mock", usage: { input_tokens: 100, output_tokens: 1 } },
		} as unknown as BetaRawMessageStreamEvent;
		const delta = {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 50 },
		} as unknown as BetaRawMessageStreamEvent;
		const state = (message: AssistantMessage) => ({
			model,
			output: message,
			stream: new AssistantMessageEventStream(),
			usageModel: model,
			inputTransformations: undefined,
		});

		it("is a lower bound until message_delta carries the output count", () => {
			const message = output();
			const shared = state(message);
			handleAnthropicStreamEvent(start, shared);
			expect(message.usage.input).toBe(100);
			expect(message.usage.lowerBound).toBe(true);

			handleAnthropicStreamEvent(delta, shared);
			expect(message.usage.output).toBe(50);
			expect(message.usage.lowerBound).toBeUndefined();
			expect("lowerBound" in message.usage).toBe(false);
		});
	});

	describe("Chat Completions", () => {
		const model = { id: "mock", provider: "openai", cost: pricing } as unknown as Model<"openai-completions">;
		const processor = (message: AssistantMessage) =>
			createCompletionsChunkProcessor(model, message, new AssistantMessageEventStream(), new Map(), new Map() as never);
		const textChunk = {
			id: "c1",
			choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
		} as unknown as ChatCompletionChunk;
		const usageChunk = {
			id: "c1",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		} as unknown as ChatCompletionChunk;

		it("is a lower bound until the final usage chunk, and stays complete after it", () => {
			const message = output();
			const chunks = processor(message);
			chunks.processChunk(textChunk);
			expect(message.usage.lowerBound).toBe(true);

			chunks.processChunk(usageChunk);
			expect(message.usage.output).toBe(5);
			expect(message.usage.lowerBound).toBeUndefined();

			chunks.processChunk(textChunk);
			expect(message.usage.lowerBound).toBeUndefined();
		});
	});

	describe("Responses", () => {
		const model = { id: "mock", provider: "openai", cost: pricing } as unknown as Model<"openai-responses">;
		async function* events(...items: unknown[]): AsyncGenerator<ResponseStreamEvent> {
			for (const item of items) yield item as ResponseStreamEvent;
		}
		const created = { type: "response.created", response: { id: "r1" } };

		it("is a lower bound when the stream drops before the terminal event", async () => {
			const message = output();
			async function* dropped(): AsyncGenerator<ResponseStreamEvent> {
				yield created as unknown as ResponseStreamEvent;
				throw new Error("terminated");
			}
			await expect(
				processResponsesStream(dropped(), message, new AssistantMessageEventStream(), model),
			).rejects.toThrow("terminated");
			expect(message.usage.lowerBound).toBe(true);
		});

		it("is complete after the terminal event", async () => {
			const message = output();
			await processResponsesStream(
				events(created, {
					type: "response.completed",
					response: {
						id: "r1",
						status: "completed",
						output: [],
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				}),
				message,
				new AssistantMessageEventStream(),
				model,
			);
			expect(message.usage.output).toBe(5);
			expect(message.usage.lowerBound).toBeUndefined();
		});
	});
});

describe("usage of a dropped Mistral stream", () => {
	const model = { id: "mock", provider: "mistral", cost: pricing } as unknown as Model<"mistral-conversations">;
	const text = { data: { id: "m1", choices: [{ index: 0, delta: { content: "hi" }, finishReason: null }] } };
	const withUsage = {
		data: {
			id: "m1",
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			choices: [{ index: 0, delta: {}, finishReason: "stop" }],
		},
	};

	it("is a lower bound when the stream drops before the usage chunk, and complete when it ends", async () => {
		const dropped = output();
		async function* failing() {
			yield text;
			throw new Error("terminated");
		}
		await expect(
			consumeChatStream(model, dropped, new AssistantMessageEventStream(), failing() as never, undefined),
		).rejects.toThrow("terminated");
		expect(dropped.usage.lowerBound).toBe(true);

		const whole = output();
		async function* complete() {
			yield text;
			yield withUsage;
		}
		await consumeChatStream(model, whole, new AssistantMessageEventStream(), complete() as never, undefined);
		expect(whole.usage.output).toBe(5);
		expect(whole.usage.lowerBound).toBeUndefined();
	});
});
