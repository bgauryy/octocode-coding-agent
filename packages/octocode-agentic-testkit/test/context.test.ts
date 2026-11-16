import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { cacheReadRatio } from "../src/context.ts";
import { script, type StepSource } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

const BIG = "lorem ipsum dolor sit amet ".repeat(40);
const calls = (n: number): StepSource[] => [
	...Array.from({ length: n }, (_, i) => ({ toolCalls: [{ name: "search", args: { query: `q${i}` } }] })),
	{ text: "done" },
];

async function run(steps: StepSource[], extra: Partial<Parameters<typeof runInproc>[0]> = {}, handler?: ToolHandler) {
	const gw = await gateway({ responder: script(steps) });
	const docs = mcp(gw, "docs", [{ ...searchTool, handler }]);
	await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()], ...extra }, "go");
	return gw;
}
type ToolHandler = (a: Record<string, unknown>) => unknown;

describe("context matchers", () => {
	it("stable prefix passes with a high simulated cache ratio", async () => {
		const gw = await run(calls(4), {}, (a) => `${BIG} ${String(a.query)}`);
		expect(gw.trace).toKeepStablePrefix();
		expect(gw.trace).toHaveCacheReadRatio({ min: 0.5 });
		expect(gw.trace.requests[0].usage!.cachedTokens).toBe(0);
		expect(gw.trace.requests[1].usage!.estimated).toBe(true);
	});

	it("an unstable system prompt breaks the prefix and the cache", async () => {
		const gw = await run(calls(4), { unstableSystem: true }, (a) => `${BIG} ${String(a.query)}`);
		expect(() => expect(gw.trace).toKeepStablePrefix()).toThrow(/message-rewritten at message 0/);
		expect(cacheReadRatio(gw.trace)).toBe(0);
		expect(() => expect(gw.trace).toHaveCacheReadRatio({ min: 0.5 })).toThrow(/ratio 0\.000/);
	});

	it("detects a tool result inserted twice", async () => {
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "search", args: { query: "a" } }] },
				{ toolCalls: [{ name: "search", args: { query: "a" } }] },
				{ text: "done" },
			]),
		});
		const docs = mcp(gw, "docs", [{ ...searchTool, handler: () => BIG }]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "go");
		expect(() => expect(gw.trace).toHaveNoDuplicateBlocks()).toThrow(/duplicate blocks: request 2 x2/);
		const clean = await run(calls(2), {}, (a) => `${BIG} unique ${String(a.query)}\n\n${String(a.query).repeat(300)}`);
		expect(clean.trace).toHaveNoDuplicateBlocks({ minChars: 100 });
	});

	it("bounds growth per turn", async () => {
		const gw = await run(calls(3), {}, () => "x".repeat(500));
		expect(gw.trace).toGrowAtMost(1500);
		expect(() => expect(gw.trace).toGrowAtMost(100)).toThrow(/grew \d+ bytes/);
	});

	it("compacts when history is large; the prefix may break once after it", async () => {
		const gw = await gateway({
			responder: script([...calls(4).slice(0, 4), { text: "done" }]),
		});
		const docs = mcp(gw, "docs", [{ ...searchTool, handler: () => BIG }]);
		const r = await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()], compactAt: 3500 }, "go");
		expect(r.answer).toBe("done");
		expect(gw.trace).toHaveCompacted();
		expect(gw.trace.requests.some((q) => q.agent === "main:compactor")).toBe(true);
		expect(() => expect(gw.trace.agent("main")).toKeepStablePrefix()).toThrow(/message-rewritten/);
		expect(gw.trace.agent("main")).toKeepStablePrefix({ allowAfterCompaction: true });
	});
});
