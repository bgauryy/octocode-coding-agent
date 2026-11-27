import { describe, expect, it } from "vitest";
import { script } from "../src/gateway.ts";
import { chat, gateway } from "./helpers.ts";

const chatBody = (extra: object = {}) => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra });
const anthropicBody = (extra: object = {}) => ({
	model: "m",
	max_tokens: 64,
	messages: [{ role: "user", content: "hi" }],
	...extra,
});
const post = (url: string, path: string, body: unknown): Promise<Response> =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const sse = (raw: string): Record<string, any>[] =>
	raw
		.split("\n\n")
		.map((b) => b.split("\n").find((l) => l.startsWith("data: {")))
		.filter((l): l is string => !!l)
		.map((l) => JSON.parse(l.slice(6)));

const both = { text: "let me look", toolCalls: [{ name: "search", args: { q: 1 } }] };

describe("text with tool calls", () => {
	it("chat completions JSON carries content and tool_calls", async () => {
		const gw = await gateway({ responder: script([both]) });
		const m = (await (await chat(gw.url, chatBody())).json()).choices[0];
		expect(m.message.content).toBe("let me look");
		expect(m.message.tool_calls[0].function.name).toBe("search");
		expect(m.finish_reason).toBe("tool_calls");
	});

	it("chat completions SSE streams the text and the tool call", async () => {
		const gw = await gateway({ responder: script([both]) });
		const chunks = sse(await (await chat(gw.url, chatBody({ stream: true }))).text());
		const deltas = chunks.flatMap((c) => (c.choices[0] ? [c.choices[0].delta] : []));
		expect(deltas.map((d) => d.content ?? "").join("")).toBe("let me look");
		expect(deltas.flatMap((d) => d.tool_calls ?? []).some((t) => t.function?.name === "search")).toBe(true);
	});

	it("Anthropic JSON has a text block before the tool_use block", async () => {
		const gw = await gateway({ responder: script([both]) });
		const r = await (await post(gw.url, "/v1/messages", anthropicBody())).json();
		expect(r.content.map((b: { type: string }) => b.type)).toEqual(["text", "tool_use"]);
		expect(r.content[0].text).toBe("let me look");
		expect(r.stop_reason).toBe("tool_use");
	});

	it("Anthropic SSE streams a text block then a tool_use block at the next index", async () => {
		const gw = await gateway({ responder: script([both]) });
		const ev = sse(await (await post(gw.url, "/v1/messages", anthropicBody({ stream: true }))).text());
		const starts = ev.filter((e) => e.type === "content_block_start");
		expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([
			[0, "text"],
			[1, "tool_use"],
		]);
		const text = ev
			.filter((e) => e.delta?.type === "text_delta")
			.map((e) => e.delta.text)
			.join("");
		expect(text).toBe("let me look");
	});

	it("Responses SSE completes with a message item and a function_call item", async () => {
		const gw = await gateway({ responder: script([both]) });
		const ev = sse(await (await post(gw.url, "/v1/responses", { model: "m", input: "hi", stream: true })).text());
		const done = ev.find((e) => e.type === "response.completed")!;
		expect(done.response.output.map((o: { type: string }) => o.type)).toEqual(["message", "function_call"]);
	});
});

describe("step fields", () => {
	it("usage overrides the simulated usage", async () => {
		const gw = await gateway({ responder: script([{ text: "x", usage: { promptTokens: 999, cachedTokens: 500 } }]) });
		const r = await (await chat(gw.url, chatBody())).json();
		expect(r.usage.prompt_tokens).toBe(999);
		expect(r.usage.prompt_tokens_details.cached_tokens).toBe(500);
		expect(gw.trace.requests[0].usage).toMatchObject({ promptTokens: 999, cachedTokens: 500 });
	});

	it("usage overrides on the Anthropic wire", async () => {
		const gw = await gateway({ responder: script([{ text: "x", usage: { cachedTokens: 42 } }]) });
		const r = await (await post(gw.url, "/v1/messages", anthropicBody())).json();
		expect(r.usage.cache_read_input_tokens).toBe(42);
	});

	it("delayMs waits before replying", async () => {
		const gw = await gateway({ responder: script([{ text: "slow", delayMs: 150 }]) });
		const t0 = Date.now();
		await (await chat(gw.url, chatBody())).json();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
	});
});

describe("error steps", () => {
	it("answers an OpenAI-shaped error with retry-after and no answer event", async () => {
		const gw = await gateway({
			responder: script([{ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }, { text: "ok" }]),
		});
		const res = await chat(gw.url, chatBody());
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("7");
		expect(await res.json()).toEqual({ error: { message: "slow down", type: "testkit_error" } });
		expect(gw.trace.of("answer")).toHaveLength(0);
		expect((await (await chat(gw.url, chatBody())).json()).choices[0].message.content).toBe("ok");
	});

	it("answers an Anthropic-shaped error without retry-after when unset", async () => {
		const gw = await gateway({ responder: script([{ error: { status: 529, message: "overloaded" } }]) });
		const res = await post(gw.url, "/v1/messages", anthropicBody());
		expect(res.status).toBe(529);
		expect(res.headers.get("retry-after")).toBeNull();
		expect(await res.json()).toEqual({ type: "error", error: { type: "api_error", message: "overloaded" } });
		expect(gw.trace.of("answer")).toHaveLength(0);
	});
});

describe("script exhaustion", () => {
	it("repeats the last step by default", async () => {
		const gw = await gateway({ responder: script([{ text: "a" }, { text: "b" }]) });
		const texts: string[] = [];
		for (let i = 0; i < 3; i++) texts.push((await (await chat(gw.url, chatBody())).json()).choices[0].message.content);
		expect(texts).toEqual(["a", "b", "b"]);
	});

	it("onExhausted: fail answers 500 and records the error (chat and Anthropic)", async () => {
		const gw = await gateway({ responder: script([{ text: "a" }], { onExhausted: "fail" }) });
		expect((await chat(gw.url, chatBody())).status).toBe(200);
		const res = await chat(gw.url, chatBody());
		expect(res.status).toBe(500);
		expect((await res.json()).error.message).toBe("script exhausted after 1 steps");
		const a = await post(gw.url, "/v1/messages", anthropicBody());
		expect(a.status).toBe(500);
		expect((await a.json()).type).toBe("error");
		expect(gw.errors).toEqual(["script exhausted after 1 steps", "script exhausted after 1 steps"]);
	});
});
