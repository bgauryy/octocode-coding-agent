import { completionsResponse } from "./completions-fetch-fixture.ts";
import type { ResponseStreamEvent } from "../src/api/ai-sdk/openai-wire-types.ts";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
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
		const model = { ...getBuiltinModel("anthropic", "claude-sonnet-4-5"), cost: pricing };
		const start = {
			type: "message_start",
			message: { id: "msg_test", model: "mock", usage: { input_tokens: 100, output_tokens: 1 } },
		};
		const delta = {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 50 },
		};
		const request = async (events: unknown[]) =>
			streamAnthropic(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
				apiKey: "test-key",
				fetch: async () =>
					new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					}),
			}).result();

		it("is a lower bound until message_delta carries the output count", async () => {
			const dropped = await request([start]);
			expect(dropped.stopReason).toBe("error");
			expect(dropped.usage.input).toBe(100);
			expect(dropped.usage.lowerBound).toBe(true);

			const message = await request([start, delta, { type: "message_stop" }]);
			expect(message.stopReason).toBe("stop");
			expect(message.usage.output).toBe(50);
			expect(message.usage.lowerBound).toBeUndefined();
			expect("lowerBound" in message.usage).toBe(false);
		});
	});

	describe("Chat Completions", () => {
		const model = {
			...getBuiltinModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			cost: pricing,
		} as Model<"openai-completions">;
		const textChunk = {
			id: "c1",
			choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
		};
		const usageChunk = {
			id: "c1",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		};

		it("stays complete when text arrives after the usage chunk", async () => {
			const message = await streamCompletions(
				model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
				{
					apiKey: "fixture",
					fetch: async () =>
						completionsResponse([
							textChunk,
							usageChunk,
							textChunk,
							{ ...textChunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						]),
				},
			).result();
			expect(message.content).toEqual([{ type: "text", text: "hihi" }]);
			expect(message.usage.output).toBe(5);
			expect(message.usage.lowerBound).toBeUndefined();
		});

		it("is a lower bound until the final usage chunk, and stays complete after it", async () => {
			const run = (withUsage: boolean) =>
				streamCompletions(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
					apiKey: "fixture",
					fetch: async () =>
						completionsResponse([
							textChunk,
							...(withUsage ? [usageChunk] : []),
							{ ...textChunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						]),
				}).result();
			expect((await run(false)).usage.lowerBound).toBe(true);
			const message = await run(true);
			expect(message.usage.output).toBe(5);
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
	const model = { ...getBuiltinModel("mistral", "mistral-large-latest"), cost: pricing };
	const text = { id: "m1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
	const terminal = {
		id: "m1",
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
	const request = (complete: boolean) =>
		streamMistral(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
			apiKey: "fixture",
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify(text)}\n\n${complete ? `data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n` : "event: error\ndata: terminated\n\n"}`,
				),
		}).result();
	it("is a lower bound when the stream drops before the usage chunk, and complete when it ends", async () => {
		const dropped = await request(false);
		expect(dropped.stopReason).toBe("error");
		expect(dropped.errorMessage).toContain("terminated");
		expect(dropped.usage.lowerBound).toBe(true);
		const whole = await request(true);
		expect(whole.stopReason).toBe("stop");
		expect(whole.usage.output).toBe(5);
		expect(whole.usage.lowerBound).toBeUndefined();
	});
});
