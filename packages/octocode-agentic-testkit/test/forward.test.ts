import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Forward } from "../src/upstream.ts";
import { gateway } from "./helpers.ts";

/*
 * Forwarding fidelity for every client wire: a request on the upstream's own wire must arrive as the harness sent
 * it, and every other pair must arrive translated with its system prompt, tools, calls and results intact.
 */

interface Seen {
	url: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

const closers: (() => void)[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
});

async function upstream(replies: Record<string, unknown>): Promise<{ base: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "";
			seen.push({ url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
			const key = Object.keys(replies).find((k) => url.endsWith(k));
			res.writeHead(key ? 200 : 404, { "content-type": "application/json" });
			res.end(JSON.stringify(key ? replies[key] : { error: "no route" }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

const ANTHROPIC_REPLY = {
	content: [
		{ type: "thinking", thinking: "check the file first", signature: "sig-abc" },
		{ type: "text", text: "reading" },
		{ type: "tool_use", id: "toolu_up", name: "Read", input: { path: "b.txt" } },
	],
	stop_reason: "tool_use",
	usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
};

const CHAT_REPLY = {
	choices: [
		{
			finish_reason: "tool_calls",
			message: {
				content: null,
				tool_calls: [{ id: "call_up", function: { name: "Read", arguments: '{"path":"b.txt"}' } }],
			},
		},
	],
	usage: { prompt_tokens: 50, completion_tokens: 4 },
};

/** What Claude Code sends: system blocks with its own cache marker, a tool round, thinking config and metadata. */
const anthropicRequest = {
	model: "claude-x",
	max_tokens: 1000,
	stream: true,
	thinking: { type: "enabled", budget_tokens: 1024 },
	metadata: { user_id: "u-1" },
	system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
	tools: [
		{
			name: "Read",
			description: "Read a file",
			input_schema: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	messages: [
		{ role: "user", content: "read a.txt" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", signature: "sig-0" },
				{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }] },
	],
};

describe("forwarding an Anthropic client", () => {
	it("to an Anthropic upstream sends the request as the harness sent it, with its beta header", async () => {
		const up = await upstream({ "/v1/messages": ANTHROPIC_REPLY });
		const forward: Forward = { baseUrl: up.base, api: "anthropic", key: "k", model: "claude-real" };
		const gw = await gateway({ forward, cassette: { mode: "off" } });
		const r = await post(
			gw.url,
			"/v1/messages",
			{ ...anthropicRequest, stream: false },
			{ "anthropic-beta": "interleaved-thinking-2025-05-14" },
		);
		expect(r.status).toBe(200);
		const [s] = up.seen;
		expect(s.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
		expect(s.headers["x-api-key"]).toBe("k");
		expect(s.body).toEqual({ ...anthropicRequest, model: "claude-real", stream: false });
	});

	it("replays the upstream's thinking blocks with their signatures, in JSON and in SSE", async () => {
		const up = await upstream({ "/v1/messages": ANTHROPIC_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "anthropic", key: "k" }, cassette: { mode: "off" } });
		const json = (await (await post(gw.url, "/v1/messages", { ...anthropicRequest, stream: false })).json()) as {
			content: unknown[];
			stop_reason: string;
		};
		expect(json.content).toEqual(ANTHROPIC_REPLY.content);
		expect(json.stop_reason).toBe("tool_use");
		const sse = await (await post(gw.url, "/v1/messages", anthropicRequest)).text();
		expect(sse).toContain('"type":"thinking_delta","thinking":"check the file first"');
		expect(sse).toContain('"type":"signature_delta","signature":"sig-abc"');
		expect(sse).toContain('"partial_json":');
		expect(gw.trace.of("model_tool_call").map((e) => e.name)).toEqual(["Read", "Read"]);
	});

	it("adds prompt-cache markers only to a request that has none", async () => {
		const up = await upstream({ "/v1/messages": ANTHROPIC_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "anthropic", key: "k" }, cassette: { mode: "off" } });
		const unmarked = { ...anthropicRequest, system: [{ type: "text", text: "You are a coding agent." }] };
		await post(gw.url, "/v1/messages", { ...unmarked, stream: false });
		await post(gw.url, "/v1/messages", { ...anthropicRequest, stream: false });
		expect(up.seen[0].body.system).toEqual([
			{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } },
		]);
		expect((up.seen[0].body.tools as { cache_control?: unknown }[]).at(-1)?.cache_control).toEqual({
			type: "ephemeral",
		});
		expect(up.seen[1].body.tools).toEqual(anthropicRequest.tools);
	});

	it("to an OpenAI upstream translates system, tools, calls and results", async () => {
		const up = await upstream({ "/chat/completions": CHAT_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "openai", key: "k" }, cassette: { mode: "off" } });
		const r = await post(gw.url, "/v1/messages", { ...anthropicRequest, stream: false, tool_choice: { type: "any" } });
		expect(r.status).toBe(200);
		const body = up.seen[0].body;
		expect(up.seen[0].url).toBe("/chat/completions");
		expect(body.messages).toEqual([
			{ role: "system", content: "You are a coding agent." },
			{ role: "user", content: "read a.txt" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } }],
			},
			{ role: "tool", tool_call_id: "toolu_1", content: "hello" },
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				function: { name: "Read", description: "Read a file", parameters: anthropicRequest.tools[0].input_schema },
			},
		]);
		expect(body).toMatchObject({ max_tokens: 1000, tool_choice: "required", stream: false });
		const reply = (await r.json()) as { content: { type: string; name?: string }[] };
		expect(reply.content.find((b) => b.type === "tool_use")?.name).toBe("Read");
	});
});

describe("forwarding a Responses client", () => {
	const responsesRequest = {
		model: "gpt-x",
		instructions: "Be brief.",
		include: ["reasoning.encrypted_content"],
		input: [
			{ role: "user", content: [{ type: "input_text", text: "read a.txt" }] },
			{ type: "reasoning", id: "rs_1", encrypted_content: "enc-0", summary: [] },
			{ type: "function_call", call_id: "fc_1", name: "read", arguments: '{"path":"a.txt"}' },
			{ type: "function_call_output", call_id: "fc_1", output: "hello" },
		],
		tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
		stream: true,
	};
	const RESPONSES_REPLY = {
		status: "completed",
		output: [
			{ type: "reasoning", id: "rs_2", encrypted_content: "enc-1", summary: [] },
			{ type: "function_call", call_id: "fc_2", name: "read", arguments: '{"path":"b.txt"}' },
		],
		usage: { input_tokens: 40, output_tokens: 3, input_tokens_details: { cached_tokens: 30 } },
	};

	it("to a Responses upstream passes through and replays the reasoning items", async () => {
		const up = await upstream({ "/responses": RESPONSES_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "responses", key: "k" }, cassette: { mode: "off" } });
		const sse = await (await post(gw.url, "/v1/responses", responsesRequest)).text();
		expect(up.seen[0].body).toEqual({ ...responsesRequest, stream: false });
		expect(sse).toContain('"encrypted_content":"enc-1"');
		expect(gw.trace.of("model_tool_call")[0]).toMatchObject({ name: "read", args: { path: "b.txt" } });
		expect(gw.trace.requests[0].usage).toMatchObject({ promptTokens: 40, cachedTokens: 30, estimated: false });
	});

	it("to a chat upstream translates the turns and the output-token limit", async () => {
		const up = await upstream({ "/chat/completions": CHAT_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "openai", key: "k" }, cassette: { mode: "off" } });
		await post(gw.url, "/v1/responses", { ...responsesRequest, max_output_tokens: 64 });
		expect(up.seen[0].body).toMatchObject({
			max_tokens: 64,
			messages: [
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "read a.txt" },
				{ role: "assistant", tool_calls: [{ id: "fc_1", function: { name: "read" } }] },
				{ role: "tool", tool_call_id: "fc_1", content: "hello" },
			],
		});
	});

	it("refuses a Responses upstream for a client on another wire", async () => {
		const up = await upstream({ "/responses": RESPONSES_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "responses", key: "k" }, cassette: { mode: "off" } });
		const r = await post(gw.url, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
		expect(r.status).toBe(502);
		expect(gw.errors[0]).toMatch(/takes only Responses clients/);
	});
});

describe("forwarding a Gemini client", () => {
	it("to a chat upstream translates contents, declarations and the calling mode", async () => {
		const up = await upstream({ "/chat/completions": CHAT_REPLY });
		const gw = await gateway({ forward: { baseUrl: up.base, api: "openai", key: "k" }, cassette: { mode: "off" } });
		const r = await post(gw.url, "/v1beta/models/gemini-x:generateContent", {
			systemInstruction: { parts: [{ text: "Be brief." }] },
			contents: [
				{ role: "user", parts: [{ text: "read a.txt" }] },
				{ role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] },
				{ role: "user", parts: [{ functionResponse: { name: "read", response: { text: "hello" } } }] },
			],
			tools: [
				{
					functionDeclarations: [
						{
							name: "read",
							description: "Read",
							parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } },
						},
					],
				},
			],
			generationConfig: { maxOutputTokens: 32 },
			toolConfig: { functionCallingConfig: { mode: "ANY" } },
		});
		expect(r.status).toBe(200);
		expect(up.seen[0].body).toMatchObject({
			model: "gemini-x",
			max_tokens: 32,
			tool_choice: "required",
			tools: [{ function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
			messages: [
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "read a.txt" },
				{ role: "assistant", tool_calls: [{ function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
				{ role: "tool", content: '{"text":"hello"}' },
			],
		});
		const reply = (await r.json()) as { candidates: { content: { parts: { functionCall?: { name: string } }[] } }[] };
		expect(reply.candidates[0].content.parts[0].functionCall?.name).toBe("Read");
	});
});

describe("an upstream that takes only max_completion_tokens", () => {
	it("gets the one rejected request again with max_completion_tokens, and every later one that way", async () => {
		const seen: Record<string, unknown>[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
				seen.push(body);
				res.writeHead("max_tokens" in body ? 400 : 200, { "content-type": "application/json" });
				res.end(
					JSON.stringify(
						"max_tokens" in body
							? {
									error: {
										message:
											"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
										code: "unsupported_parameter",
									},
								}
							: CHAT_REPLY,
					),
				);
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		closers.push(() => {
			server.closeAllConnections();
			server.close();
		});
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const gw = await gateway({ forward: { baseUrl: base, api: "openai", key: "k" }, cassette: { mode: "off" } });
		const ask = () =>
			post(gw.url, "/v1/chat/completions", { model: "m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
		expect((await ask()).status).toBe(200);
		expect((await ask()).status).toBe(200);
		expect(
			seen.map((b) => ("max_tokens" in b ? "max_tokens" : `max_completion_tokens=${String(b.max_completion_tokens)}`)),
		).toEqual(["max_tokens", "max_completion_tokens=64", "max_completion_tokens=64"]);
	});

	it("any other 400 fails as before", async () => {
		const up = await upstream({});
		const gw = await gateway({ forward: { baseUrl: up.base, api: "openai", key: "k" }, cassette: { mode: "off" } });
		const r = await post(gw.url, "/v1/chat/completions", {
			model: "m",
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(r.status).toBe(502);
		expect(gw.errors[0]).toMatch(/upstream 404/);
		expect(up.seen).toHaveLength(1);
	});
});

describe("forward.body", () => {
	it("merges model settings into every upstream request, on each upstream wire", async () => {
		const up = await upstream({ "/chat/completions": CHAT_REPLY, "/v1/messages": ANTHROPIC_REPLY });
		const chatGw = await gateway({
			forward: { baseUrl: up.base, api: "openai", key: "k", body: { reasoning_effort: "none" } },
			cassette: { mode: "off" },
		});
		await post(chatGw.url, "/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
		const anthGw = await gateway({
			forward: { baseUrl: up.base, api: "anthropic", key: "k", body: { thinking: { type: "disabled" } } },
			cassette: { mode: "off" },
		});
		await post(anthGw.url, "/v1/messages", { ...anthropicRequest, stream: false });
		expect(up.seen[0].body).toMatchObject({ reasoning_effort: "none" });
		expect(up.seen[1].body).toMatchObject({ thinking: { type: "disabled" }, system: anthropicRequest.system });
	});
});
