import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { forwardOf, resolveTier } from "../src/tiers.ts";
import { chat, gateway } from "./helpers.ts";

describe("resolveTier", () => {
	it("skips without a tier and says why", () => {
		expect(resolveTier({})).toEqual({ skip: expect.stringContaining("TESTKIT_TIER") });
	});
	it("skips an unknown tier and a paid tier without key", () => {
		expect(resolveTier({ TESTKIT_TIER: "gpt" })).toEqual({ skip: expect.stringContaining("unknown tier") });
		expect(resolveTier({ TESTKIT_TIER: "haiku", TESTKIT_HAIKU_BASE_URL: "http://x" })).toEqual({
			skip: "tier haiku: set TESTKIT_HAIKU_KEY",
		});
		expect(resolveTier({ TESTKIT_TIER: "deepseek", TESTKIT_DEEPSEEK_KEY: "k" })).toEqual({
			skip: "tier deepseek: set TESTKIT_DEEPSEEK_BASE_URL",
		});
	});
	it("local defaults to Ollama bonsai with thinking off; TESTKIT_OLLAMA=1 selects it", () => {
		for (const env of [{ TESTKIT_TIER: "local" }, { TESTKIT_OLLAMA: "1" }]) {
			const r = resolveTier(env);
			expect("tier" in r && r.tier).toMatchObject({
				name: "local",
				model: "bonsai-2:9b",
				api: "openai",
				remote: false,
				body: { reasoning_effort: "none" },
			});
		}
	});
	it("resolves paid tiers from env with default models", () => {
		const r = resolveTier({
			TESTKIT_TIER: "deepseek",
			TESTKIT_DEEPSEEK_BASE_URL: "https://t",
			TESTKIT_DEEPSEEK_KEY: "k",
		});
		expect("tier" in r && r.tier).toMatchObject({ model: "DeepSeek-V4-Flash", api: "anthropic", remote: true });
		const h = resolveTier({
			TESTKIT_TIER: "haiku",
			TESTKIT_HAIKU_BASE_URL: "https://h",
			TESTKIT_HAIKU_KEY: "k",
			TESTKIT_HAIKU_MODEL: "claude-x",
		});
		expect("tier" in h && forwardOf(h.tier)).toMatchObject({
			baseUrl: "https://h",
			model: "claude-x",
			api: "anthropic",
			key: "k",
		});
	});
});

interface Seen {
	url: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const closers: (() => void)[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
});

async function fakeAnthropic(reply: unknown, status = 200): Promise<{ base: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const request = {
	model: "client-model",
	stream_options: { include_usage: true },
	messages: [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "load the pdf skill" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "load_skill", arguments: '{"name":"pdf"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", content: "PDF body" },
		{ role: "tool", tool_call_id: "c2", content: "second" },
		{ role: "user", content: "thanks" },
	],
	tools: [
		{
			type: "function",
			function: {
				name: "load_skill",
				description: "Read a skill",
				parameters: { type: "object", properties: { name: { type: "string" } } },
			},
		},
	],
	tool_choice: "required",
	max_tokens: 77,
};

describe("gateway forward to an Anthropic upstream", () => {
	it("translates the request, authenticates with x-api-key and maps the tool-use reply and usage", async () => {
		const up = await fakeAnthropic({
			content: [
				{ type: "text", text: "loading " },
				{ type: "tool_use", id: "toolu_1", name: "load_skill", input: { name: "pdf" } },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
		});
		const gw = await gateway({
			forward: { baseUrl: `${up.base}/`, model: "claude-haiku-5-5", api: "anthropic", key: "sekret" },
		});
		const r = await chat(gw.url, request);
		expect(r.status).toBe(200);

		expect(up.seen).toHaveLength(1);
		const [s] = up.seen;
		expect(s.url).toBe("/v1/messages");
		expect(s.headers["x-api-key"]).toBe("sekret");
		expect(s.headers["anthropic-version"]).toBe("2023-06-01");
		expect(s.headers.authorization).toBeUndefined();
		expect(s.body).toMatchObject({
			model: "claude-haiku-5-5",
			system: "Be brief.",
			max_tokens: 77,
			tool_choice: { type: "any" },
			tools: [{ name: "load_skill", description: "Read a skill", input_schema: { type: "object" } }],
		});
		expect(s.body.stream).toBeUndefined();
		expect(s.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "load the pdf skill" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "load_skill", input: { name: "pdf" } }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "c1", content: "PDF body" },
					{ type: "tool_result", tool_use_id: "c2", content: "second" },
					{ type: "text", text: "thanks" },
				],
			},
		]);

		const out = (await r.json()) as {
			choices: {
				message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
				finish_reason: string;
			}[];
			usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number } };
		};
		expect(out.choices[0].finish_reason).toBe("tool_calls");
		expect(out.choices[0].message.tool_calls[0]).toMatchObject({
			id: "toolu_1",
			function: { name: "load_skill", arguments: '{"name":"pdf"}' },
		});
		expect(out.usage).toMatchObject({
			prompt_tokens: 550,
			completion_tokens: 20,
			prompt_tokens_details: { cached_tokens: 400 },
		});
		expect(gw.trace.requests[0].usage).toEqual({
			promptTokens: 550,
			cachedTokens: 400,
			completionTokens: 20,
			estimated: false,
		});
		expect(gw.trace.of("model_tool_call")[0]).toMatchObject({ name: "load_skill", args: { name: "pdf" } });
	});

	it("re-emits SSE when the client streamed", async () => {
		const up = await fakeAnthropic({
			content: [{ type: "text", text: "hello there" }],
			usage: { input_tokens: 5, output_tokens: 2 },
		});
		const gw = await gateway({ forward: { baseUrl: up.base, api: "anthropic", key: "k" } });
		const r = await chat(gw.url, { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
		expect(r.headers.get("content-type")).toContain("text/event-stream");
		const text = await r.text();
		expect(text).toContain('"content":"hello there"');
		expect(text).toContain("[DONE]");
		expect(up.seen[0].body.stream).toBeUndefined();
		expect(gw.trace.requests[0].usage?.estimated).toBe(false);
	});

	it("surfaces an upstream error as 502 and records it", async () => {
		const up = await fakeAnthropic({ error: { message: "overloaded" } }, 529);
		const gw = await gateway({ forward: { baseUrl: up.base, api: "anthropic", key: "k" } });
		const r = await chat(gw.url, { model: "m", messages: [{ role: "user", content: "hi" }] });
		expect(r.status).toBe(502);
		expect(gw.errors[0]).toContain("upstream 529");
	});

	it("aborts a call that outlives timeoutMs", async () => {
		const server = createServer(() => undefined);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		closers.push(() => {
			server.closeAllConnections();
			server.close();
		});
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const gw = await gateway({ forward: { baseUrl: base, api: "anthropic", key: "k", timeoutMs: 100 } });
		const r = await chat(gw.url, { model: "m", messages: [{ role: "user", content: "hi" }] });
		expect(r.status).toBe(502);
		expect(gw.errors).toHaveLength(1);
	});
});
