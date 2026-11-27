import { afterEach, describe, expect, it, vi } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { script } from "../src/gateway.ts";
import { mockMcp, type ToolDef } from "../src/mcp.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

async function setup(steps: Parameters<typeof script>[0]) {
	const gw = await gateway({ responder: script(steps) });
	const docs = mcp(gw, "docs", [searchTool]);
	const run = (prompt = "find it") => runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, prompt);
	return { gw, docs, run };
}

describe("mock MCP", () => {
	it("records called-with and returns the mocked value to the model", async () => {
		const { gw, docs, run } = await setup([
			{ toolCalls: [{ name: "search", args: { query: "cache" } }] },
			{ text: "found" },
		]);
		docs.tool("search").returns("RESULT-42");
		const r = await run();
		expect(r.answer).toBe("found");
		expect(docs.tool("search")).toHaveBeenCalledWith({ query: "cache" });
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
		expect(gw.trace).toHaveCalledTool("search", { times: 1 });
		expect(JSON.stringify(gw.trace.requests[1].messages)).toContain("RESULT-42");
		await expect(() => expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "nope" } })).toThrow(
			/called/,
		);
	});

	it("failOnce(error) gives an error result, then the tool works", async () => {
		const { gw, docs, run } = await setup([
			{ toolCalls: [{ name: "search", args: { query: "a" } }] },
			{ toolCalls: [{ name: "search", args: { query: "b" } }] },
			{ text: "ok" },
		]);
		docs.tool("search").failOnce("error");
		await run();
		expect(gw.trace.of("tool_error")[0]).toMatchObject({ server: "docs", name: "search" });
		expect(gw.trace.of("tool_exec")).toHaveLength(1);
		expect(gw.trace).toReflect({ after: "error" });
	});

	it("failOnce(timeout) stalls until the client aborts, then the agent gets an error result", async () => {
		const { gw, docs } = await setup([{ toolCalls: [{ name: "search", args: { query: "a" } }] }, { text: "gave up" }]);
		docs.tool("search").failOnce("timeout");
		const r = await runInproc(
			{ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client({ timeoutMs: 400 })] },
			"find it",
		);
		expect(r.answer).toBe("gave up");
		await vi.waitFor(() => expect(docs.stalledCalls()).toBe(0));
		expect(gw.trace.of("tool_error")[0].data).toMatchObject({ reason: "timeout" });
		expect(JSON.stringify(gw.trace.requests[1].messages)).toContain("Error:");
	});

	it("invalid arguments give an isError result and an invalid-args event", async () => {
		const { gw, docs, run } = await setup([
			{ toolCalls: [{ name: "search", args: { limit: "ten" } }] },
			{ toolCalls: [{ name: "search", args: { query: 5 } }] },
			{ text: "x" },
		]);
		await run();
		const errs = gw.trace.of("tool_error");
		expect(errs.map((e) => (e.data as { reason: string }).reason)).toEqual(["invalid-args", "invalid-args"]);
		expect(docs.tool("search")).not.toHaveBeenCalled();
	});

	it("speaks plain JSON-RPC (initialize, tools/list)", async () => {
		const { docs } = await setup([{ text: "x" }]);
		const url = await docs.listen();
		const init = await (
			await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18" },
				}),
			})
		).json();
		expect(init.result.serverInfo.name).toBe("docs");
		const list = await docs.client().listTools();
		expect(list.map((t) => t.name)).toEqual(["search"]);
	});
});

describe("mock MCP identity and stalls", () => {
	it("attributes a call without identity headers to the agent whose model asked for it", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "mcp__docs__search", args: { query: "q" } }] }]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		await fetch(`${gw.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-testkit-agent": "worker", "x-testkit-span": "w1" },
			body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }] }),
		});
		const raw = await fetch(await docs.listen(), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				method: "tools/call",
				params: { name: "search", arguments: { query: "q" } },
			}),
		});
		expect(raw.ok).toBe(true);
		const exec = gw.trace.of("tool_exec").at(-1)!;
		expect(exec).toMatchObject({ agent: "worker", span: "w1", server: "docs" });
	});

	it("close() releases stalled calls", async () => {
		const gw = await gateway();
		const docs = mcp(gw, "docs", [searchTool]);
		docs.tool("search").failOnce("timeout");
		const pending = docs
			.client({ timeoutMs: 20_000 })
			.callTool("search", { query: "q" })
			.catch((e: Error) => e);
		await vi.waitFor(() => expect(docs.stalledCalls()).toBe(1));
		await docs.close();
		expect(await pending).toBeInstanceOf(Error);
		expect(docs.stalledCalls()).toBe(0);
	});
});

describe("mock MCP: async handlers and JSON-schema tools", () => {
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((c) => c()));
	});
	const make = (tool: ToolDef) => {
		const m = mockMcp({ name: "x", tools: [tool] });
		closers.push(() => m.close());
		return m;
	};

	it("awaits an async handler and records the resolved value", async () => {
		const m = make({ ...searchTool, handler: async () => "REAL" });
		const r = await m.client().callTool("search", { query: "q" });
		expect(r).toEqual({ isError: false, text: "REAL" });
		expect(m.trace.of("tool_exec")[0].data).toBe("REAL");
	});

	it("awaits a returns() promise", async () => {
		const m = make(searchTool);
		m.tool("search").returns(Promise.resolve("FIXED"));
		expect(await m.client().callTool("search", { query: "q" })).toEqual({ isError: false, text: "FIXED" });
	});

	it("a rejecting handler behaves like a throwing one", async () => {
		const m = make({
			...searchTool,
			handler: async () => {
				throw new Error("boom");
			},
		});
		expect(await m.client().callTool("search", { query: "q" })).toEqual({ isError: true, text: "boom" });
		expect(m.trace.of("tool_error")[0].data).toMatchObject({ reason: "error", message: "boom" });
	});

	it("failOnce still works with async handlers", async () => {
		const m = make({ ...searchTool, handler: async () => "OK" });
		m.tool("search").failOnce("error");
		expect((await m.client().callTool("search", { query: "q" })).isError).toBe(true);
		expect((await m.client().callTool("search", { query: "q" })).text).toBe("OK");
	});

	it("validates enum, type arrays and integers", async () => {
		const m = make({
			name: "pick",
			description: "d",
			inputSchema: {
				type: "object",
				properties: {
					mode: { type: "string", enum: ["a", "b"] },
					n: { type: ["integer", "null"] },
				},
				required: ["mode"],
				additionalProperties: false,
			},
		});
		const c = m.client();
		const bad = await c.callTool("pick", { mode: "c" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toMatch(/must be one of/);
		expect(m.trace.of("tool_error")[0].data).toMatchObject({ reason: "invalid-args" });
		expect((await c.callTool("pick", { mode: "a", n: null })).isError).toBe(false);
		expect((await c.callTool("pick", { mode: "a", n: 2 })).isError).toBe(false);
		expect((await c.callTool("pick", { mode: "a", n: 2.5 })).text).toMatch(/integer or null/);
		expect((await c.callTool("pick", { mode: "a", n: "x" })).isError).toBe(true);
	});
});
