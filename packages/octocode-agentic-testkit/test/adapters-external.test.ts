import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAdapter, codexMissing } from "../src/adapters/codex/index.ts";
import { claudeCodeAdapter, claudeCodeMissing } from "../src/adapters/claude-code/index.ts";
import { script, scripts } from "../src/gateway.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
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

describe("claude-code through the lineage and a forwarding gateway", () => {
	it("a background Agent spawn is a child that reports back, with no identity header", async (ctx) => {
		const missing = claudeCodeMissing();
		if (missing) return ctx.skip(missing);
		const task = "Reply with CHILD-REPORT-9 and stop.";
		const gw = await gateway({
			responder: (c) =>
				scripts({
					main: [
						{
							toolCalls: [
								{
									name: c.request.tools.includes("Agent") ? "Agent" : "Task",
									args: { description: "check a thing", prompt: task, subagent_type: "general-purpose" },
								},
							],
						},
						{ text: "main finished" },
					],
					"general-purpose": [{ text: "CHILD-REPORT-9" }],
				})(c),
		});
		const session = await claudeCodeAdapter().start({ gatewayUrl: gw.url });
		try {
			const run = await session.run("delegate a check");
			expect(run.exitCode, run.stderr.slice(-500)).toBe(0);
			expect(gw.trace).toHaveSpawned("general-purpose", { times: 1 });
			expect(gw.trace).toHaveHandedOff("main", "general-purpose");
			expect(gw.trace).toHaveNoOrphanAgents();
			expect(gw.trace.agent("general-purpose").of("answer")[0]?.data).toBe("CHILD-REPORT-9");
			// The child has its own, smaller tool set: the lineage did not mix it into main.
			const childTools = gw.trace.agent("general-purpose").requests[0]?.tools.length ?? 0;
			expect(childTools).toBeLessThan(gw.trace.agent("main").requests[0]?.tools.length ?? 0);
		} finally {
			await session.close();
		}
	}, 150_000);

	it("forwards Claude Code's own request intact and sandboxes the CLI by default", async (ctx) => {
		const missing = claudeCodeMissing() ?? sandboxAvailable();
		if (missing) return ctx.skip(missing);
		// The "real model" is a second, scripted gateway: the forwarding path runs end to end, offline.
		const model = await gateway({
			responder: script([
				{
					toolCalls: [
						{
							name: "Bash",
							args: { command: "echo inside > in.txt; echo outside > ../../escape.txt", description: "write" },
						},
					],
				},
				{ text: "forwarded answer" },
			]),
		});
		const gw = await gateway({
			forward: { baseUrl: model.url, api: "anthropic", key: "k" },
			cassette: { mode: "off" },
		});
		const session = await claudeCodeAdapter({ keep: true }).start({ gatewayUrl: gw.url });
		try {
			const run = await session.run("write the files");
			expect(run.exitCode, run.stderr.slice(-500)).toBe(0);
			expect(gw.errors).toEqual([]);
			// The upstream got Claude Code's own system blocks and tools, not a lossy translation.
			const sent = model.trace.requests[0].raw as { system?: unknown[]; tools?: { name?: string }[] };
			expect(Array.isArray(sent.system) && sent.system.length).toBeTruthy();
			expect(sent.tools?.every((t) => typeof t.name === "string" && t.name.length > 0)).toBe(true);
			expect(JSON.stringify(sent.tools)).toContain('"name":"Bash"');
			expect(gw.trace.of("answer").at(-1)?.data).toBe("forwarded answer");
			// Sandboxed by default: the write inside the workspace landed, the one outside did not.
			expect(readFileSync(join(run.workspace, "in.txt"), "utf8")).toBe("inside\n");
			expect(existsSync(join(run.workspace, "..", "..", "escape.txt"))).toBe(false);
		} finally {
			await session.close();
			rmSync(join(tmpdir(), "escape.txt"), { force: true });
		}
	}, 150_000);
});
