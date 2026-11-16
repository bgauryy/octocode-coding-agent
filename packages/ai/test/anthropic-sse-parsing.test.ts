import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model, ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function responseOptions(response: Response) {
	return { apiKey: "test-key", fetch: async () => response };
}

describe("Anthropic SSE body lifetime", () => {
	it("cancels the response body when the consumer stops early", async () => {
		let cancelled = false;
		const first = `event: message_start\ndata: ${minimalAnthropicEvents[0].data}\n\n`;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(first));
				// The server keeps the stream open; only a cancel releases it.
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		const result = await streamAnthropic(
			getBuiltinModel("anthropic", "claude-sonnet-4-5"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				...responseOptions(response),
				onProviderStreamEvent: () => {
					throw new Error("consumer failed");
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(cancelled).toBe(true);
	});

	it("cancels the response body when the response hook fails", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			// The server keeps the stream open; only a cancel releases it.
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		const result = await streamAnthropic(
			getBuiltinModel("anthropic", "claude-sonnet-4-5"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				...responseOptions(response),
				onResponse: () => {
					throw new Error("hook failure");
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("hook failure");
		expect(cancelled).toBe(true);
	});
});

type ResponseContentBlock = { type: "thinking"; thinking: string; signature: string } | { type: "text"; text: string };

function createResponseModelSseResponse(model: string, contentBlock: ResponseContentBlock): Response {
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: { id: "msg_response_model", model, usage: { input_tokens: 100, output_tokens: 0 } },
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: contentBlock }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 100, output_tokens: 20 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

describe("Anthropic raw SSE parsing", () => {
	it("forwards parsed provider stream events in order", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const providerEvents: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				...responseOptions(createSseResponse(minimalAnthropicEvents)),
				onProviderStreamEvent: async (event, eventModel) => {
					await Promise.resolve();
					providerEvents.push(event);
					eventModels.push(eventModel);
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(providerEvents.map((event) => (event as { type: string }).type)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(eventModels).toEqual([model, model, model, model, model, model]);
	});

	it("keeps signed thinking replayable when a proxy relabels the model", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5");
		const responseModel = "kimi-for-coding";
		const initialContext = normalizeContext({
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		});
		const first = await streamAnthropic(model, initialContext, {
			...responseOptions(
				createResponseModelSseResponse(responseModel, {
					type: "thinking",
					thinking: "reasoning",
					signature: "signature",
				}),
			),
		}).result();

		expect(first.model).toBe(model.id);
		expect(first.responseModel).toBe(responseModel);

		const transformed = transformMessages([...initialContext.messages, first], model);
		const replayedAssistant = transformed.find((message) => message.role === "assistant");
		expect(replayedAssistant?.content).toEqual([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature" },
		]);
	});

	it("uses a returned fallback model for cost attribution", async () => {
		const fallbackModel = "fallback-model";
		const model: Model<"anthropic-messages"> = {
			...getBuiltinModel("anthropic", "claude-opus-5"),
			compat: {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: fallbackModel,
						cost: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		};
		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				...responseOptions(createResponseModelSseResponse(fallbackModel, { type: "text", text: "done" })),
			},
		).result();

		expect(result.model).toBe(model.id);
		expect(result.responseModel).toBe(fallbackModel);
		expect(result.usage.cost.input).toBeCloseTo(0.0003, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.0001, 10);
	});

	it("fails safely when Anthropic falls back after output begins", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5");
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_fallback",
						model: "claude-opus-5",
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "partial" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "fallback",
						from: { model: "claude-opus-5" },
						to: { model: "claude-opus-4-8" },
					},
				}),
			},
		]);

		const result = await streamAnthropic(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ ...responseOptions(response) },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unsupported mid-output model fallback");
	});

	it("forces streaming after an onPayload replacement", async () => {
		let streaming: boolean | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			streaming = JSON.parse(init?.body as string).stream;
			return createSseResponse(minimalAnthropicEvents);
		};

		await streamAnthropic(
			getBuiltinModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{
				apiKey: "test-key",
				fetch,
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), stream: false }),
			},
		).result();

		expect(streaming).toBe(true);
	});

	it("omits the interleaved-thinking beta when thinking is disabled", async () => {
		let betaFeatures: string[] | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			betaFeatures = new Headers(init?.headers).get("anthropic-beta")?.split(",");
			return createSseResponse(minimalAnthropicEvents);
		};

		await streamAnthropic(
			getBuiltinModel("openrouter", "anthropic/claude-haiku-4.5"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ apiKey: "test-key", fetch, thinkingEnabled: false },
		).result();

		expect(betaFeatures ?? []).not.toContain("interleaved-thinking-2025-05-14");
	});

	it("passes managed beta features to injected clients", async () => {
		let betaFeatures: string[] | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			betaFeatures = new Headers(init?.headers).get("anthropic-beta")?.split(",");
			return createSseResponse(minimalAnthropicEvents);
		};

		const result = await streamAnthropic(
			getBuiltinModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ apiKey: "test-key", fetch },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(betaFeatures).toContain("mid-conversation-output-config-2026-07-01");
		expect(betaFeatures).toContain("thinking-binding-controls-2026-08-01");
	});

	it("uses the serving model input transformations from the final stream event", async () => {
		const events = minimalAnthropicEvents.map((event) => ({ ...event }));
		events[0].data = JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_transformations",
				model: "claude-fable-5-1",
				usage: { input_tokens: 12, output_tokens: 0 },
				input_transformations: [
					{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
				],
			},
		});
		const delta = JSON.parse(events[4].data) as Record<string, unknown>;
		delta.input_transformations = [
			{ type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
		];
		events[4].data = JSON.stringify(delta);

		const result = await streamAnthropic(
			getBuiltinModel("anthropic", "claude-fable-5-1"),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ ...responseOptions(createSseResponse(events)) },
		).result();

		expect(result.diagnostics).toEqual([
			{
				type: "anthropic_input_transformations",
				timestamp: expect.any(Number),
				details: {
					transformations: [
						{
							type: "thinking_dropped",
							path: "messages.3.content.0",
							reason: "model_binding_mismatch",
						},
					],
				},
			},
		]);
	});
	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		});

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("preserves content from content_block_start events", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_initial_content",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "Initial text" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "thinking",
						thinking: "Initial thinking",
						signature: "initial signature",
					},
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "thinking_delta", thinking: " plus delta" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "signature_delta", signature: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.content).toEqual([
			{ type: "text", text: "Initial text plus delta" },
			{
				type: "thinking",
				thinking: "Initial thinking plus delta",
				thinkingSignature: "initial signature plus delta",
			},
		]);
	});

	it("preserves refusal stop details from message_delta", async () => {
		const model = getBuiltinModel("anthropic", "claude-fable-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		});
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, provide feedback, or request an exemption based on how you use Claude, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_01XFUDYJgAACzvnptvVoYEL",
						usage: {
							input_tokens: 412,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation,
						},
					},
					usage: {
						input_tokens: 412,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("refusal");
		expect(result.errorMessage).toBe(explanation);
	});

	it("preserves sensitive stop reasons with a descriptive error message", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_sensitive",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "sensitive" },
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("sensitive");
		expect(result.errorMessage).toBe("Provider stopped with: sensitive");
	});

	it("treats message_delta without usage as a no-op for usage accumulation", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse(
			minimalAnthropicEvents.map((event) =>
				event.event === "message_delta"
					? {
							event: "message_delta",
							data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
						}
					: event,
			),
		);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.totalTokens).toBe(12);
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		});
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			...responseOptions(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});

describe("Anthropic SSE chunk boundaries", () => {
	it("preserves CRLF events at every possible byte split", async () => {
		const wire = minimalAnthropicEvents.map(({ event, data }) => `event: ${event}\r\ndata: ${data}\r\n\r\n`).join("");
		for (let split = 1; split < wire.length; split++) {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(wire.slice(0, split)));
					controller.enqueue(new TextEncoder().encode(wire.slice(split)));
					controller.close();
				},
			});
			const result = await streamAnthropic(
				getBuiltinModel("anthropic", "claude-sonnet-4-5"),
				normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
				{ ...responseOptions(new Response(body)) },
			).result();
			expect(result.stopReason, `split ${split}: ${result.errorMessage}`).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		}
	});
});
