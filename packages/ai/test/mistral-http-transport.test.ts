import { arch, platform, release } from "node:os";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, FetchFunction, Model, ProviderResponse } from "../src/types.ts";

const OCTOCODE_USER_AGENT = `octocode (${platform()} ${release()}; ${arch()})`;

function createSseResponse(events: unknown[], headers?: Record<string, string>): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\r\n\r\n")}\r\n\r\ndata: [DONE]\r\n\r\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

function createBytewiseSseResponse(event: unknown): Response {
	const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`);
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function createTerminalEvent(finishReason = "stop") {
	return {
		id: "mistral-response-id",
		model: "mistral-large-latest",
		choices: [{ index: 0, finish_reason: finishReason, delta: {} }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

describe("Mistral HTTP transport", () => {
	it("exposes the SDK-generated wire payload to the payload hook", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			systemPrompt: "Be precise",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: Type.Object({ query: Type.String() }),
				},
			],
		});
		let requestUrl: string | undefined;
		let requestInit: RequestInit | undefined;
		let callbackPayload: Record<string, unknown> | undefined;
		let callbackResponse: ProviderResponse | undefined;
		const fetch: FetchFunction = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return createSseResponse(
				[
					{
						...createTerminalEvent("tool_calls"),
						choices: [
							{
								index: 0,
								finish_reason: "tool_calls",
								delta: {
									tool_calls: [
										{ index: 0, id: "abc123456", function: { name: "lookup", arguments: '{"query":"test"}' } },
									],
								},
							},
						],
					},
				],
				{ "x-request-id": "request-1" },
			);
		};

		const message = await streamMistral(model, context, {
			apiKey: "secret",
			fetch,
			headers: { "x-custom": "value" },
			maxTokens: 123,
			promptMode: "reasoning",
			reasoningEffort: "high",
			toolChoice: { type: "function", function: { name: "lookup" } },
			sessionId: "session-1",
			onPayload: (payload) => {
				callbackPayload = payload as Record<string, unknown>;
				return {
					...callbackPayload,
					top_p: 0.9,
					random_seed: 42,
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "result",
							schema: {
								type: "object",
								properties: { maxTokens: { type: "number" } },
							},
						},
					},
					presence_penalty: 0.1,
					frequency_penalty: 0.2,
					parallel_tool_calls: true,
					safe_prompt: true,
				};
			},
			onResponse: (response) => {
				callbackResponse = response;
			},
		}).result();

		expect(message.errorMessage).toBeUndefined();
		expect(message.stopReason).toBe("toolUse");
		expect(requestUrl).toBe("https://api.mistral.ai/v1/chat/completions");
		const headers = new Headers(requestInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer secret");
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("x-affinity")).toBe("session-1");
		expect(headers.get("x-custom")).toBe("value");
		expect(headers.get("user-agent")).toBe(OCTOCODE_USER_AGENT);
		expect(callbackPayload?.max_tokens).toBe(123);
		expect(callbackPayload?.prompt_mode).toBe("reasoning");
		expect(callbackPayload?.prompt_cache_key).toBe("session-1");
		expect(callbackResponse).toEqual({
			status: 200,
			headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
		});

		const wirePayload = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
		expect(wirePayload.max_tokens).toBe(123);
		expect(wirePayload.prompt_mode).toBe("reasoning");
		expect(wirePayload.reasoning_effort).toBe("high");
		expect(wirePayload.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
		expect(wirePayload.prompt_cache_key).toBe("session-1");
		expect(wirePayload.top_p).toBe(0.9);
		expect(wirePayload.random_seed).toBe(42);
		expect(wirePayload.presence_penalty).toBe(0.1);
		expect(wirePayload.frequency_penalty).toBe(0.2);
		expect(wirePayload.parallel_tool_calls).toBe(true);
		expect(wirePayload.safe_prompt).toBe(true);
		expect(wirePayload.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "result",
				schema: {
					type: "object",
					properties: { maxTokens: { type: "number" } },
				},
			},
		});
		expect(wirePayload).not.toHaveProperty("maxTokens");
		expect(wirePayload).not.toHaveProperty("promptMode");
		expect(wirePayload).not.toHaveProperty("promptCacheKey");
		expect(wirePayload.messages).toEqual([
			{ role: "system", content: "Be precise" },
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
				],
			},
		]);
	});

	it("serializes assistant thinking, tool calls, and tool results for replay", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [
				{
					role: "assistant",
					api: "mistral-conversations",
					provider: "mistral",
					model: model.id,
					content: [
						{ type: "thinking", thinking: "reason" },
						{ type: "text", text: "answer" },
						{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "abc123456",
					toolName: "lookup",
					content: [
						{ type: "text", text: "found" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		});
		let requestInit: RequestInit | undefined;
		const fetch: FetchFunction = async (_input, init) => {
			requestInit = init;
			return createSseResponse([createTerminalEvent()]);
		};

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("stop");
		const wirePayload = JSON.parse(String(requestInit?.body)) as { messages: unknown[] };
		expect(wirePayload.messages).toEqual([
			{
				role: "assistant",
				prefix: false,
				content: [
					{ type: "thinking", thinking: [{ type: "text", text: "reason" }], closed: true },
					{ type: "text", text: "answer" },
				],
				tool_calls: [
					{
						id: "abc123456",
						type: "function",
						function: { name: "lookup", arguments: '{"query":"pi"}' },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "abc123456",
				name: "lookup",
				content: [
					{ type: "text", text: "found" },
					{ type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
				],
			},
		]);
	});

	it("parses native thinking, text, fragmented tool calls, and cached-token usage", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const events = [
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "reason" }] }] },
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: { content: [{ type: "text", text: "answer" }] },
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: {
							tool_calls: [
								{
									id: "abc123456",
									index: 0,
									function: { name: "lookup", arguments: '{"query":' },
								},
							],
						},
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: "tool_calls",
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { name: "", arguments: '"pi"}' },
								},
							],
						},
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 4,
					total_tokens: 14,
					prompt_tokens_details: { cached_tokens: 3 },
				},
			},
		];
		const fetch: FetchFunction = async () => createSseResponse(events);

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.rawStopReason).toBe("tool_calls");
		expect(message.responseId).toBe("response-1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
		]);
		expect(message.usage).toMatchObject({ input: 7, output: 4, cacheRead: 3, cacheWrite: 0, totalTokens: 14 });
	});

	// #9674: GLM models on Mistral send empty content deltas at the start, around tool calls,
	// and sometimes mid-thinking. They must not open blocks or split thinking.
	it("ignores empty content deltas", async () => {
		const model = getBuiltinModel("mistral", "zai-glm-5-3");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const thinking = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }] });
		const toolCall = (args: string, first: boolean) => ({
			index: 0,
			...(first ? { id: "abc123456" } : {}),
			function: { name: first ? "read" : "", arguments: args },
		});
		const deltas = [
			{ content: "" },
			{ content: [thinking("first part,")] },
			{ content: "" },
			{ content: [{ type: "text", text: "" }] },
			{ content: [thinking(" second part."), { type: "text", text: "Reading." }] },
			{ content: "", tool_calls: [toolCall("", true)] },
			{ content: "", tool_calls: [toolCall('{"path":', false)] },
			{ content: "", tool_calls: [toolCall('"a.txt"}', false)] },
			{ content: "" },
		];
		const events = deltas.map((delta, i) => ({
			id: "response-1",
			model: model.id,
			choices: [{ index: 0, finish_reason: i === deltas.length - 1 ? "tool_calls" : null, delta }],
		}));

		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: async () => createSseResponse(events),
		}).result();

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "first part, second part." },
			{ type: "text", text: "Reading." },
			{ type: "toolCall", id: "abc123456", name: "read", arguments: { path: "a.txt" } },
		]);
	});

	it("forwards each parsed SSE payload before normalizing it", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const events = [
			{
				id: "response-1",
				provider_metadata: { request: "test" },
				choices: [{ index: 0, finish_reason: null, delta: { content: "hello" } }],
			},
			{
				id: "response-1",
				choices: [{ index: 0, finish_reason: "stop", delta: {} }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			},
		];
		const received: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamMistral(model, context, {
			apiKey: "test",
			fetch: async () => createSseResponse(events),
			onProviderStreamEvent: async (event, eventModel) => {
				await Promise.resolve();
				received.push(event);
				eventModels.push(eventModel);
			},
		}).result();

		expect(received).toEqual(events);
		expect(eventModels).toEqual([model, model]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("parses SSE and UTF-8 sequences split across transport chunks", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const fetch: FetchFunction = async () =>
			createBytewiseSseResponse({
				id: "response-bytewise",
				model: model.id,
				choices: [{ index: 0, finish_reason: "stop", delta: { content: "héllo 🌍" } }],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			});

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "héllo 🌍" }]);
	});

	it("honors case-insensitive header overrides and explicit affinity suppression", async () => {
		const model = {
			...getBuiltinModel("mistral", "mistral-large-latest"),
			headers: { Authorization: "Bearer model-key", "X-Affinity": "model-affinity" },
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		let requestHeaders: Headers | undefined;
		const fetch: FetchFunction = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return createSseResponse([createTerminalEvent()]);
		};

		await streamMistral(model, context, {
			apiKey: "request-key",
			fetch,
			sessionId: "automatic-affinity",
			headers: { authorization: null, "x-affinity": null, "User-Agent": "custom-agent" },
		}).result();

		expect(requestHeaders?.has("authorization")).toBe(false);
		expect(requestHeaders?.has("x-affinity")).toBe(false);
		expect(requestHeaders?.get("user-agent")).toBe("custom-agent");
	});

	it("aborts while waiting for an SSE chunk", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const controller = new AbortController();
		const fetch: FetchFunction = async () =>
			new Response(
				new ReadableStream({
					start() {},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);

		const result = streamMistral(model, context, {
			apiKey: "test",
			fetch,
			signal: controller.signal,
		}).result();
		controller.abort();
		const message = await result;

		expect(message.stopReason).toBe("aborted");
	});

	it.each([undefined, "short"] as const)(
		"resolves cache retention from request env with explicit override %s",
		async (cacheRetention) => {
			const model = getBuiltinModel("mistral", "mistral-large-latest");
			const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
			let requestHeaders: Headers | undefined;
			let payload: Record<string, unknown> | undefined;
			const result = await streamMistral(model, context, {
				apiKey: "test",
				sessionId: "session",
				env: { OCTOCODE_CACHE_RETENTION: "none" },
				cacheRetention,
				fetch: async (_url, init) => {
					requestHeaders = new Headers(init?.headers);
					payload = JSON.parse(String(init?.body));
					return createSseResponse([createTerminalEvent()]);
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(payload?.prompt_cache_key).toBe(cacheRetention ? "session" : undefined);
			expect(requestHeaders?.get("x-affinity")).toBe(cacheRetention ? "session" : null);
		},
	);

	it("applies the request timeout while waiting for response headers", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const fetch: FetchFunction = (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});

		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch,
			timeoutMs: 5,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Mistral response headers timed out after 5ms");
	});

	// Regression test for #10609: an active stream must not be cut off after timeoutMs.
	it("does not abort an active stream that lasts longer than the request timeout", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const encoder = new TextEncoder();
		const thinkingEvent = {
			choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "x" }] }] } }],
		};
		const fetch: FetchFunction = async (_url, init) =>
			new Response(
				new ReadableStream({
					async start(controller) {
						const onAbort = () => controller.error(init?.signal?.reason);
						init?.signal?.addEventListener("abort", onAbort, { once: true });
						for (let i = 0; i < 5; i++) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingEvent)}\n\n`));
							await new Promise((resolve) => setTimeout(resolve, 10));
							if (init?.signal?.aborted) return;
						}
						init?.signal?.removeEventListener("abort", onAbort);
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(createTerminalEvent())}\n\ndata: [DONE]\n\n`));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);

		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch,
			timeoutMs: 20,
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "thinking", thinking: "xxxxx" }]);
	});

	it("preserves HTTP status and response bodies in errors", async () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const fetch: FetchFunction = async () =>
			new Response('{"message":"blocked by gateway"}', { status: 403, statusText: "Forbidden" });

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe('Mistral API error (403): {"message":"blocked by gateway"}');
	});
});
