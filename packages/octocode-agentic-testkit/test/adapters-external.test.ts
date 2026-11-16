import { describe, expect, it } from "vitest";
import { codexAdapter, codexMissing } from "../src/adapters/codex/index.ts";
import { claudeCodeAdapter, claudeCodeMissing } from "../src/adapters/claude-code/index.ts";
import { script } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

describe("claude-code via gateway", () => {
	it("calls the mock MCP tool once, then answers", async (ctx) => {
		const missing = claudeCodeMissing();
		if (missing) return ctx.skip(missing);
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "cache" } }] },
				{ text: "the cache docs say hello" },
			]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await claudeCodeAdapter().start({ gatewayUrl: gw.url, mcpUrls: { docs: await docs.listen() } });
		try {
			const run = await session.run("find the cache docs");
			const reqs = gw.trace.requests;
			const raw0 = reqs[0]?.raw as { system?: unknown; tools?: unknown[] } | undefined;
			console.info(
				`[claude-code] ${JSON.stringify({
					requests: reqs.length,
					models: [...new Set(reqs.map((r) => r.model))],
					systemBytes: Buffer.byteLength(JSON.stringify(raw0?.system ?? "")),
					toolCount: reqs[0]?.tools.length,
					requestBytes: reqs.map((r) => Buffer.byteLength(JSON.stringify(r.raw))),
					streamed: reqs.map((r) => r.stream),
					exitCode: run.exitCode,
					durationMs: run.durationMs,
				})}`,
			);
			expect(run.stderr).not.toMatch(/ECONNREFUSED/);
			expect(gw.trace.requests.length).toBeGreaterThanOrEqual(2);
			expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
			expect(gw.trace.of("answer").at(-1)?.data).toBe("the cache docs say hello");
			expect(JSON.stringify(run.events)).toContain("the cache docs say hello");
		} finally {
			await session.close();
		}
	}, 150_000);
});

describe("codex via gateway", () => {
	it("calls the mock MCP tool once through /v1/responses, then answers", async (ctx) => {
		const missing = codexMissing();
		if (missing) return ctx.skip(missing);
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__docs.search", args: { query: "cache" } }] },
				{ text: "codex says hello" },
			]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await codexAdapter().start({ gatewayUrl: gw.url, mcpUrls: { docs: await docs.listen() } });
		try {
			const run = await session.run("find the cache docs");
			const reqs = gw.trace.requests;
			const raw = reqs[0]?.raw as { instructions?: string; tools?: unknown[] } | undefined;
			console.info(
				`[codex] ${JSON.stringify({
					requests: reqs.length,
					instructionsBytes: Buffer.byteLength(raw?.instructions ?? ""),
					toolCount: reqs[0]?.tools.length,
					requestBytes: reqs.map((r) => Buffer.byteLength(JSON.stringify(r.raw))),
					streamed: reqs.map((r) => r.stream),
					exitCode: run.exitCode,
					durationMs: run.durationMs,
				})}`,
			);
			expect(gw.errors).toEqual([]);
			expect(reqs.length).toBeGreaterThanOrEqual(2);
			expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
			expect(gw.trace.of("answer").at(-1)?.data).toBe("codex says hello");
			expect(run.stdout).toContain("codex says hello");
		} finally {
			await session.close();
		}
	}, 150_000);
});
