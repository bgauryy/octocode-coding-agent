import { afterEach, describe, expect, it } from "vitest";
import { mockMcp, type MockMcpOptions, type ToolDef } from "../src/mcp.ts";
import { searchTool } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((c) => c()));
});
const make = (opts: Partial<MockMcpOptions> = {}) => {
	const m = mockMcp({ name: "x", tools: [searchTool], ...opts });
	closers.push(() => m.close());
	return m;
};

interface Raw {
	status: number;
	session: string | null;
	body: { result?: Record<string, unknown>; error?: { code: number; message: string }; id?: unknown } | undefined;
}

/** One raw POST: a JSON body (or a string sent as is) with optional headers. */
async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Raw> {
	const r = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const raw = await r.text();
	return { status: r.status, session: r.headers.get("mcp-session-id"), body: raw ? JSON.parse(raw) : undefined };
}
const request = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mock MCP: JSON-RPC framing", () => {
	it("must fail: a batch is answered with a JSON-RPC error, not swallowed with 202", async () => {
		const url = await make().listen();
		const r = await post(url, [request("ping"), request("tools/list", undefined, 2)]);
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
		expect(r.body?.error?.message).toMatch(/batch/);
	});

	it("must fail: malformed JSON is a JSON-RPC parse error; a non-message object is an invalid request", async () => {
		const url = await make().listen();
		const parse = await post(url, '{"jsonrpc": "2.0", "id": 1,');
		expect(parse.status).toBe(400);
		expect(parse.body).toMatchObject({ id: null, error: { code: -32700 } });
		expect((await post(url, { hello: 1 })).body).toMatchObject({ error: { code: -32600 } });
		expect((await post(url, "42")).body).toMatchObject({ error: { code: -32600 } });
	});

	it("still accepts notifications and client responses with 202, and answers an unknown method with -32601", async () => {
		const url = await make().listen();
		expect((await post(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
		expect((await post(url, { jsonrpc: "2.0", id: 7, result: {} })).status).toBe(202);
		expect((await post(url, request("nope/nothing"))).body).toMatchObject({ id: 1, error: { code: -32601 } });
	});
});

describe("mock MCP: sessions", () => {
	it("issues Mcp-Session-Id on initialize, counts requests carrying it, and accepts requests without it", async () => {
		const m = make();
		const url = await m.listen();
		const init = await post(url, request("initialize", { protocolVersion: "2025-06-18" }));
		expect(init.session).toMatch(/^[\x21-\x7e]+$/);
		const session = { "mcp-session-id": init.session! };
		expect((await post(url, request("ping"), session)).status).toBe(200);
		expect((await post(url, request("tools/list"), session)).body?.result?.tools).toHaveLength(1);
		expect((await post(url, request("ping"))).status).toBe(200);
		expect(m.sessions()).toEqual([{ id: init.session, requests: 2, closed: false }]);
	});

	it("must fail: an unknown session id gets 404, and so does one the client ended with DELETE", async () => {
		const m = make();
		const url = await m.listen();
		const unknown = await post(url, request("ping"), { "mcp-session-id": "never-issued" });
		expect(unknown.status).toBe(404);
		expect(unknown.body).toMatchObject({ error: { code: -32001 } });
		const { session } = await post(url, request("initialize", {}));
		expect((await fetch(url, { method: "DELETE", headers: { "mcp-session-id": session! } })).status).toBe(200);
		expect((await post(url, request("ping"), { "mcp-session-id": session! })).status).toBe(404);
		expect(m.sessions()).toEqual([{ id: session, requests: 0, closed: true }]);
	});

	it("the client sends the session back, and starts a new session after the server ended its own", async () => {
		const m = make();
		const url = await m.listen();
		const client = m.client();
		expect(await client.listTools()).toHaveLength(1);
		const [first] = m.sessions();
		// notifications/initialized and tools/list
		expect(first.requests).toBe(2);
		await fetch(url, { method: "DELETE", headers: { "mcp-session-id": first.id } });
		expect((await client.callTool("search", { query: "q" })).isError).toBe(false);
		expect(m.sessions().map((s) => [s.closed, s.requests])).toEqual([
			[true, 2],
			[false, 2],
		]);
	});
});

describe("mock MCP: resources and prompts", () => {
	const resources = [
		{ uri: "file:///docs/a.md", name: "a", mimeType: "text/markdown", text: "# A" },
		{ uri: "file:///docs/b.txt", name: "b", description: "plain", text: "B" },
	];
	const prompts = [
		{
			name: "review",
			description: "Review a file",
			arguments: [
				{ name: "path", required: true },
				{ name: "tone", description: "optional" },
			],
			messages: (args: Record<string, string>) => [{ role: "user" as const, content: `review ${args.path}` }],
		},
		{ name: "hello", messages: [{ role: "assistant" as const, content: { type: "text", text: "hi" } }] },
	];

	it("advertises resources and prompts only when configured; otherwise their methods are unknown", async () => {
		const plain = await make().listen();
		const caps = (await post(plain, request("initialize", {}))).body?.result?.capabilities;
		expect(caps).toEqual({ tools: {} });
		expect((await post(plain, request("resources/list"))).body?.error?.code).toBe(-32601);
		expect((await post(plain, request("prompts/get", { name: "review" }))).body?.error?.code).toBe(-32601);
		const both = await make({ resources, prompts }).listen();
		expect((await post(both, request("initialize", {}))).body?.result?.capabilities).toEqual({
			tools: {},
			resources: {},
			prompts: {},
		});
	});

	it("lists resources without their text, reads one, and records the read on its spy", async () => {
		const m = make({ resources });
		const url = await m.listen();
		expect((await post(url, request("resources/list"))).body?.result).toEqual({
			resources: [
				{ uri: "file:///docs/a.md", name: "a", mimeType: "text/markdown" },
				{ uri: "file:///docs/b.txt", name: "b", description: "plain" },
			],
		});
		expect((await post(url, request("resources/read", { uri: "file:///docs/a.md" }))).body?.result).toEqual({
			contents: [{ uri: "file:///docs/a.md", mimeType: "text/markdown", text: "# A" }],
		});
		expect(m.resource("file:///docs/a.md")).toHaveBeenCalledWith("file:///docs/a.md");
		expect(m.resource("file:///docs/b.txt")).not.toHaveBeenCalled();
		m.resource("file:///docs/b.txt").mockReturnValueOnce("CHANGED");
		expect((await post(url, request("resources/read", { uri: "file:///docs/b.txt" }))).body?.result).toEqual({
			contents: [{ uri: "file:///docs/b.txt", text: "CHANGED" }],
		});
		expect((await post(url, request("resources/read", { uri: "file:///nope" }))).body?.error?.code).toBe(-32002);
		expect((await post(url, request("resources/read", {}))).body?.error?.code).toBe(-32602);
		expect(() => m.resource("file:///nope")).toThrow(/no resource/);
	});

	it("lists prompts without messages and builds a prompt from its arguments", async () => {
		const m = make({ prompts });
		const url = await m.listen();
		expect((await post(url, request("prompts/list"))).body?.result).toEqual({
			prompts: [{ name: "review", description: "Review a file", arguments: prompts[0].arguments }, { name: "hello" }],
		});
		const got = await post(url, request("prompts/get", { name: "review", arguments: { path: "a.ts" } }));
		expect(got.body?.result).toEqual({
			description: "Review a file",
			messages: [{ role: "user", content: { type: "text", text: "review a.ts" } }],
		});
		expect(m.prompt("review")).toHaveBeenCalledWith({ path: "a.ts" });
		expect((await post(url, request("prompts/get", { name: "hello" }))).body?.result).toEqual({
			messages: [{ role: "assistant", content: { type: "text", text: "hi" } }],
		});
	});

	it("must fail: prompts/get rejects an unknown prompt, a missing required argument and a non-string argument", async () => {
		const m = make({ prompts });
		const url = await m.listen();
		for (const params of [
			{ name: "nope" },
			{ name: "review", arguments: { tone: "kind" } },
			{ name: "review", arguments: { path: 1 } },
		])
			expect((await post(url, request("prompts/get", params))).body?.error?.code).toBe(-32602);
		expect(m.prompt("review")).not.toHaveBeenCalled();
	});

	it("must fail: two resources with one URI, or two prompts with one name, are a configuration error", () => {
		expect(() => mockMcp({ name: "d", tools: [], resources: [resources[0], resources[0]] })).toThrow(
			/duplicate resource file:\/\/\/docs\/a\.md/,
		);
		expect(() => mockMcp({ name: "d", tools: [], prompts: [prompts[1], prompts[1]] })).toThrow(
			/duplicate prompt hello/,
		);
	});
});

describe("mock MCP: structured output", () => {
	const stats: ToolDef = {
		name: "stats",
		description: "Counts",
		inputSchema: { type: "object", properties: {} },
		outputSchema: {
			type: "object",
			properties: { count: { type: "integer" }, files: { type: "array", items: { type: "string" } } },
			required: ["count"],
		},
		handler: () => ({ count: 2, files: ["a", "b"] }),
	};

	it("advertises outputSchema and sends structuredContent beside the JSON text", async () => {
		const m = make({ tools: [stats, searchTool] });
		const c = m.client();
		const listed = await c.listTools();
		expect(listed[0].outputSchema).toEqual(stats.outputSchema);
		expect(listed[1]).not.toHaveProperty("outputSchema");
		expect(await c.callTool("stats", {})).toEqual({
			isError: false,
			text: '{"count":2,"files":["a","b"]}',
			structuredContent: { count: 2, files: ["a", "b"] },
		});
		expect(m.trace.of("tool_exec")[0].data).toEqual({ count: 2, files: ["a", "b"] });
	});

	it("must fail: an object that breaks outputSchema is an invalid-output error result", async () => {
		const m = make({ tools: [stats] });
		m.tool("stats").returns({ count: 2, files: ["a", 3] });
		const r = await m.client().callTool("stats", {});
		expect(r).toEqual({ isError: true, text: "invalid output: $.files[1] must be string, got number" });
		expect(m.trace.of("tool_error")[0].data).toEqual({
			reason: "invalid-output",
			message: "$.files[1] must be string, got number",
		});
		expect(m.trace.of("tool_exec")).toEqual([]);
	});

	it("sends no structuredContent for a non-object result, or for a tool without outputSchema", async () => {
		const m = make({ tools: [stats, { ...searchTool, handler: () => ({ hits: 1 }) }] });
		m.tool("stats").returns("plain text");
		const c = m.client();
		expect(await c.callTool("stats", {})).toEqual({ isError: false, text: "plain text" });
		expect(await c.callTool("search", { query: "q" })).toEqual({ isError: false, text: '{"hits":1}' });
	});
});
