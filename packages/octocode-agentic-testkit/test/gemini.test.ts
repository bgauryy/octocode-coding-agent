import { describe, expect, it } from "vitest";
import { script } from "../src/gateway.ts";
import { gateway } from "./helpers.ts";

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

const GEN = "/v1beta/models/gemini-2.5-flash:generateContent";
const STREAM = "/v1beta/models/gemini-2.5-flash:streamGenerateContent";
const user = (text: string) => ({ role: "user", parts: [{ text }] });
const tools = [{ functionDeclarations: [{ name: "search", description: "d" }, { name: "read" }] }];
const sse = (s: string): any[] =>
	s
		.split(/\r?\n\r?\n/)
		.filter(Boolean)
		.map((b) => JSON.parse(b.replace(/^data: /, "")));

describe("Gemini wire", () => {
	it("answers generateContent as JSON and captures model, system, roles and tools", async () => {
		const gw = await gateway({ responder: script([{ text: "hello" }]) });
		const r = await post(
			gw.url,
			GEN,
			{
				systemInstruction: { parts: [{ text: "be brief" }] },
				contents: [user("hi"), { role: "model", parts: [{ text: "yo" }] }, user("again")],
				tools,
			},
			{ "x-testkit-agent": "lead", "x-testkit-span": "s1" },
		);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(j.candidates[0]).toMatchObject({
			content: { role: "model", parts: [{ text: "hello" }] },
			finishReason: "STOP",
		});
		expect(j.usageMetadata).toMatchObject({ promptTokenCount: expect.any(Number), candidatesTokenCount: 2 });
		const req = gw.trace.requests[0];
		expect(req).toMatchObject({ model: "gemini-2.5-flash", agent: "lead", span: "s1", stream: false });
		expect(req.tools).toEqual(["search", "read"]);
		expect(req.messages.map((m) => [m.role, m.content])).toEqual([
			["system", "be brief"],
			["user", "hi"],
			["assistant", "yo"],
			["user", "again"],
		]);
		expect(gw.trace.events.some((e) => e.kind === "answer" && e.agent === "lead" && e.span === "s1")).toBe(true);
	});

	it("streams SSE with alt=sse and a JSON array without it", async () => {
		const text = "x".repeat(60);
		const gw = await gateway({ responder: script([{ text, usage: { cachedTokens: 3 } }]) });
		const s = await post(gw.url, `${STREAM}?alt=sse`, { contents: [user("hi")] });
		expect(s.headers.get("content-type")).toContain("text/event-stream");
		const ev = sse(await s.text());
		expect(ev.length).toBeGreaterThan(1);
		expect(ev.map((e) => e.candidates[0].content.parts[0].text).join("")).toBe(text);
		expect(ev[0].candidates[0].finishReason).toBeUndefined();
		expect(ev.at(-1).candidates[0].finishReason).toBe("STOP");
		expect(ev.at(-1).usageMetadata.cachedContentTokenCount).toBe(3);
		expect(gw.trace.requests[0].stream).toBe(true);

		const a = await post(gw.url, STREAM, { contents: [user("hi")] });
		expect(a.headers.get("content-type")).toContain("application/json");
		const arr = await a.json();
		expect(Array.isArray(arr)).toBe(true);
		expect(arr.map((e: any) => e.candidates[0].content.parts[0].text).join("")).toBe(text);
		expect(arr.at(-1).candidates[0].finishReason).toBe("STOP");
		expect(gw.trace.requests[1].stream).toBe(false);
	});

	it("round-trips a tool call: functionCall out, functionResponse parsed as a tool result", async () => {
		const gw = await gateway({
			responder: script([{ text: "looking", toolCalls: [{ name: "search", args: { query: "x" } }] }, { text: "done" }]),
		});
		const r1 = await (await post(gw.url, GEN, { contents: [user("find x")], tools })).json();
		expect(r1.candidates[0].content.parts).toEqual([
			{ text: "looking" },
			{ functionCall: { name: "search", args: { query: "x" } } },
		]);
		await post(gw.url, GEN, {
			tools,
			contents: [
				user("find x"),
				r1.candidates[0].content,
				{ role: "user", parts: [{ functionResponse: { name: "search", response: { hits: 2 } } }] },
			],
		});
		const msgs = gw.trace.requests[1].messages;
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
		expect(msgs[1].tool_calls?.[0].function).toEqual({ name: "search", arguments: '{"query":"x"}' });
		expect(msgs[2]).toMatchObject({ name: "search", tool_call_id: "search", content: '{"hits":2}' });
		expect(gw.trace).toHaveCalledTool("search", { args: { query: "x" }, times: 1 });
		expect(() => expect(gw.trace).toHaveCalledTool("read")).toThrow();
	});

	it("links results to calls by the optional id, so two calls to one tool stay distinct", async () => {
		const gw = await gateway({ responder: script([{ text: "done" }]) });
		const call = (id: string, query: string) => ({ functionCall: { id, name: "search", args: { query } } });
		const result = (id: string) => ({ functionResponse: { id, name: "search", response: { id } } });
		await post(gw.url, GEN, {
			tools,
			contents: [
				user("find"),
				{ role: "model", parts: [call("c1", "a"), call("c2", "b")] },
				{ role: "user", parts: [result("c1"), result("c2")] },
			],
		});
		const msgs = gw.trace.requests[0].messages;
		expect(msgs[1].tool_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
	});

	it("streams tool calls as functionCall parts", async () => {
		const gw = await gateway({ responder: script([{ toolCalls: [{ name: "read", args: { path: "a" } }] }]) });
		const ev = sse(await (await post(gw.url, `${STREAM}?alt=sse`, { contents: [user("go")] })).text());
		expect(ev.flatMap((e) => e.candidates[0].content.parts)).toEqual([
			{ functionCall: { name: "read", args: { path: "a" } } },
		]);
		expect(gw.trace).toHaveCalledTool("read");
	});

	it("overrides usage and honors delayMs", async () => {
		const gw = await gateway({
			responder: script([
				{ text: "ok", delayMs: 60, usage: { promptTokens: 100, cachedTokens: 40, completionTokens: 7 } },
			]),
		});
		const t0 = Date.now();
		const j = await (await post(gw.url, GEN, { contents: [user("hi")] })).json();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
		expect(j.usageMetadata).toMatchObject({
			promptTokenCount: 100,
			cachedContentTokenCount: 40,
			candidatesTokenCount: 7,
		});
		expect(gw.trace.requests[0].usage).toMatchObject({ promptTokens: 100, cachedTokens: 40 });
	});

	it("answers an error step with the status, Google error body and retry-after", async () => {
		const gw = await gateway({
			responder: script([{ error: { status: 429, message: "slow down", retryAfterSeconds: 7 } }, { text: "ok" }]),
		});
		const r = await post(gw.url, GEN, { contents: [user("hi")] });
		expect(r.status).toBe(429);
		expect(r.headers.get("retry-after")).toBe("7");
		expect(await r.json()).toEqual({ error: { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED" } });
		const ok = await post(gw.url, GEN, { contents: [user("hi")] });
		expect(ok.status).toBe(200);
	});

	it("does not match other paths", async () => {
		const gw = await gateway();
		expect((await post(gw.url, "/v1beta/models/m:countTokens", {})).status).toBe(404);
	});
});
