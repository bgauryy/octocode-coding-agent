import { describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEvent, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends Api>(api: T, provider: string): Model<T> {
	return {
		api,
		provider,
		baseUrl: "https://proxy.invalid/v1",
		id: "test-model",
		name: "Test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const encoder = new TextEncoder();
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const sseHeaders = { "content-type": "text/event-stream" };

function body(chunks: string[], ending: "close" | "reset" | "hold", onCancel?: () => void) {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index++]));
				return;
			}
			if (ending === "close") controller.close();
			else if (ending === "reset") controller.error(new TypeError("terminated"));
			else return new Promise(() => {});
		},
		cancel: onCancel,
	});
}
const terminals = (events: AssistantMessageEvent[]) =>
	events.filter((event) => event.type === "done" || event.type === "error");
async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const seen: AssistantMessageEvent[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}

const message = {
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "hello", annotations: [] }],
};
const responsesStart = [
	frame({ type: "response.created", response: { id: "resp_1", created_at: 1, model: "test-model" } }),
	frame({
		type: "response.output_item.added",
		output_index: 0,
		item: { ...message, status: "in_progress", content: [] },
	}),
	frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hel" }),
];
const googleChunk = (text: string, finishReason?: string) =>
	frame({
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason, index: 0 }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
	});
const anthropicEvents = [
	{
		type: "message_start",
		message: { id: "m", type: "message", role: "assistant", model: "t", content: [], usage: { input_tokens: 10 } },
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
	{ type: "message_stop" },
];

interface Case {
	name: string;
	start: (response: () => Response, options: StreamOptions) => ReturnType<typeof responses>;
	partial: string[];
	text: string;
}
const cases: Case[] = [
	{
		name: "openai-responses",
		start: (response, options) =>
			responses(model("openai-responses", "openai"), context, { ...options, fetch: async () => response() }),
		partial: responsesStart,
		text: "hel",
	},
	{
		name: "google-generative-ai",
		start: (response, options) =>
			google(model("google-generative-ai", "google"), context, { ...options, fetch: async () => response() }),
		partial: [googleChunk("hel")],
		text: "hel",
	},
];

describe.each(cases)("$name tail risks", ({ start, partial, text }) => {
	it("reports one error and ends once without inventing content when the stream resets after content, with no refetch", async () => {
		const fetch = vi.fn(() => new Response(body(partial, "reset"), { headers: sseHeaders }));
		const events = start(fetch, { apiKey: "key", maxRetries: 2 });
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		const result = await events.result();
		expect(result.stopReason).toBe("error");
		// Content still queued in the SDK pipeline when the reset lands may be dropped, but nothing may be invented.
		for (const block of result.content) expect(text.startsWith(block.type === "text" ? block.text : "?")).toBe(true);
	});

	it("does not refetch when the stream resets before any content", async () => {
		const fetch = vi.fn(() => new Response(body([": ping\n\n"], "reset"), { headers: sseHeaders }));
		const events = start(fetch, { apiKey: "key", maxRetries: 2 });
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(terminals(seen)[0].type).toBe("error");
	});

	it("aborts a held-open stream once, keeps partial text and flags usage as incomplete", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const fetch = vi.fn(() => new Response(body(partial, "hold", cancel), { headers: sseHeaders }));
		const events = start(fetch, { apiKey: "key", maxRetries: 2, signal: controller.signal });
		const seen: AssistantMessageEvent[] = [];
		for await (const event of events) {
			seen.push(event);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await events.result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.content).toMatchObject([{ type: "text", text }]);
		expect(result.usage.lowerBound).toBe(true);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
	});
});

describe("duplicate terminals", () => {
	it("Anthropic counts a repeated message_stop and message_delta once", async () => {
		const frames = [...anthropicEvents, anthropicEvents[4], anthropicEvents[5]].map(frame);
		const events = anthropic(model("anthropic-messages", "anthropic"), context, {
			apiKey: "key",
			maxRetries: 0,
			fetch: async () => new Response(frames.join(""), { headers: sseHeaders }),
		});
		const seen = await collect(events);
		expect(terminals(seen)).toHaveLength(1);
		const result = await events.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(result.usage).toMatchObject({ input: 10, output: 2 });
	});

	it("Google ends at the first finish chunk and does not double its content", async () => {
		const events = google(model("google-generative-ai", "google"), context, {
			apiKey: "key",
			maxRetries: 0,
			fetch: async () =>
				new Response(`${googleChunk("hi", "STOP")}${googleChunk("hi", "STOP")}`, { headers: sseHeaders }),
		});
		const seen = await collect(events);
		expect(terminals(seen)).toHaveLength(1);
		expect((await events.result()).usage).toMatchObject({ input: 10 });
	});
});

describe("usage on failure", () => {
	it("Google keeps usage reported by earlier chunks when the stream resets", async () => {
		const events = google(model("google-generative-ai", "google"), context, {
			apiKey: "key",
			maxRetries: 0,
			fetch: async () => new Response(body([googleChunk("hel")], "reset"), { headers: sseHeaders }),
		});
		const result = await events.result();
		expect(result.stopReason).toBe("error");
		expect(result.usage).toMatchObject({ input: 10, output: 2 });
	});
});
