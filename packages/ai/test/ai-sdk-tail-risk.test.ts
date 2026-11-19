import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
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

/** A body that emits `chunks`, then fails or stays open. */
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

const chatText = (text: string, finish: string | null = null) =>
	frame({ id: "c", choices: [{ delta: { content: text }, finish_reason: finish }] });
const chatUsage = frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } });

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
	const seen: AssistantMessageEvent[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}
const terminals = (events: AssistantMessageEvent[]) =>
	events.filter((event) => event.type === "done" || event.type === "error");

function run(response: () => Response, options: Partial<StreamOptions> = {}) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
	const events = completions(model("openai-completions", "openai"), context, {
		apiKey: "key",
		maxRetries: 2,
		fetch,
		...options,
	});
	return { fetch, events };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("reset before content", () => {
	it("does not refetch (and double bill) when the stream resets after the first byte", async () => {
		const { fetch, events } = run(() => new Response(body([": keep-alive\n\n"], "reset"), { headers: sseHeaders }));
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(terminals(seen)[0].type).toBe("error");
	});

	it("keeps exact usage and partial text when the stream resets mid-content", async () => {
		const { fetch, events } = run(
			() => new Response(body([chatText("par"), chatUsage], "reset"), { headers: sseHeaders }),
		);
		const result = await events.result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "par" }]);
		expect(result.usage).toMatchObject({ input: 11, output: 3 });
	});
});

describe("abort", () => {
	it("keeps usage already reported and cancels the body", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const message = {
			type: "message_start",
			message: { id: "m", type: "message", role: "assistant", model: "t", content: [], usage: { input_tokens: 10 } },
		};
		const chunks = [
			frame(message),
			frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
		];
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(body(chunks, "hold", cancel), { headers: sseHeaders }),
		);
		const events = anthropic(model("anthropic-messages", "anthropic"), context, {
			apiKey: "key",
			maxRetries: 2,
			fetch,
			signal: controller.signal,
		});
		const seen: AssistantMessageEvent[] = [];
		for await (const event of events) {
			seen.push(event);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await events.result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.usage.input).toBe(10);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
	});

	it("leaves no abort listeners or timers after success, error or abort", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const added = vi.spyOn(caller.signal, "addEventListener");
		const removed = vi.spyOn(caller.signal, "removeEventListener");
		const ok = run(() => new Response(chatText("hi", "stop"), { headers: sseHeaders }), {
			signal: caller.signal,
			timeoutMs: 60_000,
		});
		expect((await ok.events.result()).stopReason).toBe("stop");
		const failed = run(() => new Response("nope", { status: 400 }), { signal: caller.signal, timeoutMs: 60_000 });
		expect((await failed.events.result()).stopReason).toBe("error");
		const reset = run(() => new Response(body([chatText("x")], "reset"), { headers: sseHeaders }), {
			signal: caller.signal,
			timeoutMs: 60_000,
		});
		expect((await reset.events.result()).stopReason).toBe("error");
		const held = run(() => new Response(body([chatText("x")], "hold"), { headers: sseHeaders }), {
			signal: caller.signal,
			timeoutMs: 60_000,
		});
		const pending = held.events.result();
		await vi.advanceTimersByTimeAsync(10);
		caller.abort();
		expect((await pending).stopReason).toBe("aborted");
		const listenersAdded = added.mock.calls.filter(([type]) => type === "abort").length;
		const listenersRemoved = removed.mock.calls.filter(([type]) => type === "abort").length;
		// "once" listeners fire and drop on abort; every one added by a finished call must be gone or consumed.
		expect(listenersAdded - listenersRemoved).toBeLessThanOrEqual(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("black-swan bodies", () => {
	it("ends an empty 200 once, with a terminal event", async () => {
		const { fetch, events } = run(() => new Response("", { headers: sseHeaders }));
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
	});

	it("fails once on a malformed frame without retrying", async () => {
		const { fetch, events } = run(() => new Response(`${chatText("a")}data: {not json\n\n`, { headers: sseHeaders }));
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(terminals(seen)[0].type).toBe("error");
	});

	it("emits one terminal event for a duplicated finish chunk and trailing [DONE]s", async () => {
		const { events } = run(
			() =>
				new Response(`${chatText("a", "stop")}${chatText("", "stop")}${chatUsage}data: [DONE]\n\ndata: [DONE]\n\n`, {
					headers: sseHeaders,
				}),
		);
		const seen = await collect(events);
		expect(terminals(seen)).toHaveLength(1);
		expect(terminals(seen)[0].type).toBe("done");
		expect((await events.result()).content).toEqual([{ type: "text", text: "a" }]);
	});

	it("handles a multi-megabyte chunk without truncating it", async () => {
		const text = "x".repeat(4 * 1024 * 1024);
		const { events } = run(() => new Response(chatText(text, "stop"), { headers: sseHeaders }));
		const result = await events.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text }]);
	});

	it("fails, bounded, on a single frame beyond the SSE buffer limit", async () => {
		const cancel = vi.fn();
		const huge = `data: ${"y".repeat(17 * 1024 * 1024)}`;
		const { events } = run(() => new Response(body([huge], "hold", cancel), { headers: sseHeaders }));
		const result = await events.result();
		expect(result.stopReason).toBe("error");
	});

	it("gives up on a body held open silently, once, and releases it", async () => {
		const cancel = vi.fn();
		const { fetch, events } = run(() => new Response(body([chatText("a")], "hold", cancel), { headers: sseHeaders }), {
			streamIdleTimeoutMs: 30,
			maxRetries: 0,
		});
		const seen = await collect(events);
		expect(fetch).toHaveBeenCalledOnce();
		expect(terminals(seen)).toHaveLength(1);
		expect(terminals(seen)[0].type).toBe("error");
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
	});
});
