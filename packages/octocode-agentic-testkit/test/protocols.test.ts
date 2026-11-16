import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { script, startGateway } from "../src/gateway.ts";
import { chat, gateway, mcp, searchTool } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const messages = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
	fetch(`${url}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
		body: JSON.stringify(body),
	});

const aBody = (extra: object = {}) => ({
	model: "claude-x",
	max_tokens: 100,
	system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
	messages: [{ role: "user", content: "hi" }],
	tools: [{ name: "search", description: "d", input_schema: { type: "object" } }],
	...extra,
});

function sse(raw: string): { event: string; data: Record<string, any> }[] {
	return raw
		.split("\n\n")
		.filter(Boolean)
		.map((block) => {
			const [e, d] = block.split("\n");
			return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
		});
}

describe("Anthropic /v1/messages", () => {
	it("answers JSON and normalizes the request into the trace", async () => {
		const gw = await gateway({ responder: script([{ text: "hello" }]) });
		const r = await (await messages(gw.url, aBody(), { "x-testkit-agent": "planner" })).json();
		expect(r).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn", model: "claude-x" });
		expect(r.content).toEqual([{ type: "text", text: "hello" }]);
		expect(r.usage).toMatchObject({ output_tokens: expect.any(Number), cache_read_input_tokens: 0 });
		expect(gw.trace.requests[0]).toMatchObject({ agent: "planner", tools: ["search"] });
		expect(gw.trace.requests[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
		expect(gw.trace.of("answer")[0].data).toBe("hello");
	});

	it("streams text with the full event sequence and cache-read usage", async () => {
		const gw = await gateway({ responder: script([{ text: "a fairly long streamed answer text here" }]) });
		await messages(gw.url, aBody());
		const events = sse(await (await messages(gw.url, aBody({ stream: true }))).text());
		expect(events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			...Array(2).fill("content_block_delta"),
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(events[0].data.message).toMatchObject({ role: "assistant", content: [] });
		expect(
			events
				.filter((e) => e.event === "content_block_delta")
				.map((e) => e.data.delta.text)
				.join(""),
		).toBe("a fairly long streamed answer text here");
		const delta = events.find((e) => e.event === "message_delta")!.data;
		expect(delta.delta.stop_reason).toBe("end_turn");
		expect(delta.usage.cache_read_input_tokens).toBeGreaterThan(0);
	});

	it("streams tool_use with input_json_delta and reads tool_result back", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "x" } }] }, { text: "done" }]),
		});
		const events = sse(await (await messages(gw.url, aBody({ stream: true }))).text());
		const start = events.find((e) => e.event === "content_block_start")!.data;
		expect(start.content_block).toMatchObject({ type: "tool_use", name: "search", input: {} });
		const json = events
			.filter((e) => e.data.delta?.type === "input_json_delta")
			.map((e) => e.data.delta.partial_json)
			.join("");
		expect(JSON.parse(json)).toEqual({ query: "x" });
		expect(events.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use");
		expect(gw.trace.of("model_tool_call")[0].args).toEqual({ query: "x" });

		await messages(
			gw.url,
			aBody({
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: start.content_block.id, name: "search", input: { query: "x" } }],
					},
					{ role: "user", content: [{ type: "tool_result", tool_use_id: start.content_block.id, content: "RESULT" }] },
				],
			}),
		);
		const second = gw.trace.requests[1].messages;
		expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(second[2].tool_calls?.[0].function).toEqual({ name: "search", arguments: '{"query":"x"}' });
		expect(second[3]).toMatchObject({ tool_call_id: start.content_block.id, content: "RESULT" });
	});

	it("accepts x-api-key as the token", async () => {
		const gw = await gateway({ token: "t0k" });
		expect((await messages(gw.url, aBody())).status).toBe(401);
		expect((await messages(gw.url, aBody(), { "x-api-key": "t0k" })).status).toBe(200);
	});
});

describe("cassettes", () => {
	const file = () => {
		const d = mkdtempSync(join(tmpdir(), "testkit-cassette-"));
		dirs.push(d);
		return join(d, "run.json");
	};
	const steps = [
		{ toolCalls: [{ name: "search", args: { query: "cache" } }] },
		{ toolCalls: [{ name: "search", args: { query: "cache" } }] },
		{ text: "found it" },
	];

	async function runWith(cassette: { file: string; mode: "record" | "replay" }, responder = script(steps)) {
		const gw = await gateway({ responder, cassette });
		const docs = mcp(gw, "docs", [searchTool]);
		const r = await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "find it");
		return { gw, r };
	}
	const shape = (gw: Awaited<ReturnType<typeof gateway>>) => ({
		hashes: gw.trace.requests.map((r) => r.hash),
		usage: gw.trace.requests.map((r) => r.usage),
		events: gw.trace.events.map((e) => [e.kind, e.agent, e.name, e.args, e.data]),
	});

	it("records a run, then replays it with no responder and the same trace", async () => {
		const f = file();
		const rec = await runWith({ file: f, mode: "record" });
		const saved = (JSON.parse(readFileSync(f, "utf8")) as { entries: Record<string, unknown> }).entries;
		expect(Object.keys(saved)).toHaveLength(3);
		expect(Object.keys(saved).every((k) => /^[0-9a-f]{16}#\d+$/.test(k))).toBe(true);

		const rep = await runWith({ file: f, mode: "replay" }, () => {
			throw new Error("responder must not run in replay");
		});
		expect(rep.r.answer).toBe("found it");
		expect(shape(rep.gw)).toEqual(shape(rec.gw));
		expect(rep.gw.errors).toEqual([]);
	});

	it("fails clearly on a request the cassette does not hold", async () => {
		const f = file();
		await runWith({ file: f, mode: "record" });
		const gw = await gateway({ cassette: { file: f, mode: "replay" } });
		const res = await chat(gw.url, { model: "m", messages: [{ role: "user", content: "never recorded" }] });
		expect(res.status).toBe(502);
		expect(JSON.stringify(await res.json())).toMatch(/cassette miss: no recorded reply for [0-9a-f]{16}#0/);
		expect(gw.errors[0]).toMatch(/cassette miss/);
		await expect(startGateway({ cassette: { file: `${f}.missing`, mode: "replay" } })).rejects.toThrow(
			/does not exist/,
		);
	});
});

describe("raw cache checks", () => {
	const ask = (url: string, system: string, _n: number) =>
		chat(url, {
			model: "m",
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: "same user turn" },
			],
		});

	it("a real timestamp in the system prompt breaks the prefix, masked mode lets it pass", async () => {
		const gw = await gateway();
		await ask(gw.url, "now is 2026-11-16T10:00:00.123Z", 1);
		await ask(gw.url, "now is 2026-11-16T10:00:01.456Z", 2);
		expect(() => expect(gw.trace).toKeepStablePrefix()).toThrow(/message-rewritten at message 0/);
		expect(() => expect(gw.trace).toKeepStablePrefix({ raw: true })).toThrow(/message-rewritten/);
		expect(gw.trace).toKeepStablePrefix({ raw: false });
		// the cassette key and canonical hash stay masked
		expect(gw.trace.requests[0].canonical).toContain("<date>");
		expect(gw.trace.requests[0].hash).toBe(gw.trace.requests[1].hash);
	});

	it("estimated cache reads see the timestamp too", async () => {
		const gw = await gateway();
		const same = "prefix ".repeat(100);
		await ask(gw.url, same, 1);
		await ask(gw.url, same, 2);
		expect(gw.trace.requests[1].usage!.cachedTokens).toBeGreaterThan(0);
		const gw2 = await gateway();
		await ask(gw2.url, "t=2026-11-16T10:00:00Z " + same, 1);
		await ask(gw2.url, "t=2026-11-16T10:00:09Z " + same, 2);
		expect(gw2.trace.requests[1].usage!.cachedTokens).toBe(0);
	});
});
