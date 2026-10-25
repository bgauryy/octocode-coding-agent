import type { AssistantMessage, AssistantMessageEvent, Model } from "@octocodeai/octocode-ai";
import { normalizeContext } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("cancels and unlocks the response body when an event cannot be parsed", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: invalid-json\n\n"));
			},
			cancel,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect((await stream.result()).stopReason).toBe("error");
		expect(cancel).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(body.locked).toBe(false));
	});

	it("closes the response body at a terminal event without consuming later events", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const done = { type: "done", reason: "stop", usage };
				const trailing = { type: "text_start", contentIndex: 0 };
				controller.enqueue(
					new TextEncoder().encode(`data: ${JSON.stringify(done)}\n\ndata: ${JSON.stringify(trailing)}\n\n`),
				);
			},
			cancel,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
		expect(cancel).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(body.locked).toBe(false));
	});

	it("preserves abort reporting and releases the cancelled body", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
			},
			cancel,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
			signal: controller.signal,
		});
		const iterator = stream[Symbol.asyncIterator]();
		expect((await iterator.next()).value?.type).toBe("start");
		controller.abort();

		expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: "Request aborted by user" });
		expect(cancel).toHaveBeenCalledOnce();
		expect((await iterator.next()).value?.type).toBe("error");
		expect((await iterator.next()).done).toBe(true);
		await vi.waitFor(() => expect(body.locked).toBe(false));
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	it("processes terminal metadata when the event is not newline-terminated", async () => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage, providerThinkingLevel: "high" })}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.providerThinkingLevel).toBe("high");
	});

	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});
});
