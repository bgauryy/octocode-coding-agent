import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import { script, startGateway, type Gateway } from "../src/gateway.ts";
import { never } from "../src/guards.ts";
import { mockMcp } from "../src/mcp.ts";
import { recordMcp, type RecordedMcp, type RecordMcpOptions } from "../src/mcp-record.ts";
import { analyzeSurface } from "../src/surface.ts";
import { searchTool } from "./helpers.ts";

/*
 * recordMcp: a real MCP server (stdio or HTTP) behind a recording endpoint, measured call by call. The reference loop
 * names MCP tools by their own name; a CLI harness sends `mcp__<server>__<tool>`.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of closers.splice(0).reverse()) await c();
});

async function setup(
	steps: Parameters<typeof script>[0],
	opts: Partial<RecordMcpOptions> = {},
): Promise<{ gw: Gateway; rec: RecordedMcp; run: (prompt: string) => Promise<void> }> {
	const gw = await startGateway({ responder: script(steps) });
	closers.push(() => gw.close());
	const rec = recordMcp({
		name: "fx",
		trace: gw.trace,
		target: { command: process.execPath, args: [FIXTURE] },
		...opts,
	});
	closers.push(() => rec.close());
	const session = await referenceAdapter({ trace: gw.trace }).start({
		gatewayUrl: gw.url,
		mcpUrls: { fx: await rec.listen() },
	});
	closers.push(() => session.close());
	return { gw, rec, run: async (prompt) => void (await session.run(prompt)) };
}

describe("recordMcp over stdio", () => {
	it("an agent's call reaches the real server, and the trace and calls() record it", async () => {
		const { gw, rec, run } = await setup([
			{ toolCalls: [{ name: "echo", args: { text: "hello" } }] },
			{ toolCalls: [{ name: "big", args: { n: 4000 } }] },
			{ text: "done" },
		]);
		await run("go");
		expect(gw.trace).toHaveCalledMcp("fx", "echo", { args: { text: "hello" }, before: "answer" });
		expect(gw.trace).toFollowTrajectory(["echo", "big"]);
		const [echo, big] = rec.calls();
		expect(echo).toMatchObject({ tool: "echo", agent: "main", isError: false, chars: 5, argChars: 16 });
		expect(big).toMatchObject({ tool: "big", chars: 4000, estTokens: 1000 });
		expect(rec.summary()).toMatchObject({ calls: 2, errors: 0, resultChars: 4005, maxChars: 4000 });
		// What the model read back is the server's own result, as the gateway saw it.
		expect(JSON.stringify(gw.trace.requests[1].messages.at(-1))).toContain("hello");
	});

	it("an error result is a tool_error, so recovery checks see the real failure", async () => {
		const { gw, rec, run } = await setup([
			{ toolCalls: [{ name: "fail", args: {} }] },
			{ toolCalls: [{ name: "echo", args: { text: "retry differently" } }] },
			{ text: "done" },
		]);
		await run("go");
		expect(gw.trace.of("tool_error")[0]).toMatchObject({
			name: "fail",
			server: "fx",
			data: { reason: "error-result", message: "fixture failure" },
		});
		expect(gw.trace).toReflect({ after: "error" });
		expect(rec.summary()).toMatchObject({ calls: 2, errors: 1 });
	});

	it("a guard stops a call before the real server runs it", async () => {
		const { gw, rec, run } = await setup([{ toolCalls: [{ name: "fail", args: {} }] }, { text: "done" }], {
			guards: [never("fail")],
		});
		await run("go");
		expect(gw.trace).toHaveBlocked("fail");
		expect(rec.calls()[0]).toMatchObject({ tool: "fail", blocked: expect.stringContaining("forbidden") });
	});

	it("answers the server's roots/list with its working directory", async () => {
		const { rec } = await setup([{ text: "x" }], {
			target: { command: process.execPath, args: [FIXTURE], cwd: "/tmp" },
		});
		const r = await rec.client().callTool("roots", {});
		expect(JSON.parse(r.text).roots[0].uri).toMatch(/^file:\/\/\/(private\/)?tmp/);
	});

	it("exposes the real tools and instructions for surface review, and transformTools changes only what agents see", async () => {
		const { rec } = await setup([{ text: "x" }], {
			transformTools: (tools) => tools.map((t) => (t.name === "echo" ? { ...t, description: "Repeat the text." } : t)),
		});
		expect(rec.instructions).toBe("Use echo first.");
		expect(rec.defs.find((t) => t.name === "echo")?.description).toBe("Repeat the text.");
		expect((await rec.client().listTools()).map((t) => t.name)).toEqual(["echo", "fail", "big", "slow", "roots"]);
		const report = analyzeSurface({ servers: [rec], instructions: { fx: rec.instructions ?? "" } });
		expect(report.items.map((i) => i.name)).toContain("mcp__fx__echo");
		// The real server still runs the call.
		expect((await rec.client().callTool("echo", { text: "ok" })).text).toBe("ok");
	});

	it("a server that exits fails the call loudly, with its stderr", async () => {
		const rec = recordMcp({
			name: "gone",
			trace: (await startGateway()).trace,
			target: { command: process.execPath, args: ["-e", "process.exit(3)"] },
		});
		closers.push(() => rec.close());
		await expect(rec.ready()).rejects.toThrow(/exited \(3\)/);
	});

	it("a call slower than timeoutMs is an upstream tool_error", async () => {
		const { gw, rec } = await setup([{ text: "x" }], { timeoutMs: 200 });
		await expect(rec.client().callTool("slow", { ms: 1000 })).rejects.toThrow();
		expect(gw.trace.of("tool_error")[0]).toMatchObject({ name: "slow", data: { reason: "upstream" } });
		expect(rec.calls()[0].error).toMatch(/timed out after 200 ms/);
	});
});

describe("recordMcp over Streamable HTTP", () => {
	it("records calls to an HTTP server and keeps its session", async () => {
		const gw = await startGateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "cache" } }] }, { text: "done" }]),
		});
		closers.push(() => gw.close());
		const upstream = mockMcp({ name: "upstream", tools: [searchTool] });
		upstream.tool("search").returns("docs/cache.md");
		closers.push(() => upstream.close());
		const rec = recordMcp({ name: "docs", trace: gw.trace, target: { url: await upstream.listen() } });
		closers.push(() => rec.close());
		const session = await referenceAdapter({ trace: gw.trace }).start({
			gatewayUrl: gw.url,
			mcpUrls: { docs: await rec.listen() },
		});
		closers.push(() => session.close());
		await session.run("find the cache docs");
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" } });
		expect(rec.calls()[0]).toMatchObject({ tool: "search", chars: "docs/cache.md".length });
		expect(upstream.sessions()).toHaveLength(1);
		expect(upstream.sessions()[0].requests).toBeGreaterThanOrEqual(2);
	});
});
