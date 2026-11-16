import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

interface Seen {
	path: string;
	body: Record<string, unknown>;
}

/** Minimal `/v1/responses` stand-in: the gateway has no Responses route, so this only proves the codex wiring. */
async function responsesStub(): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0];
			if (req.method !== "POST" || !path.endsWith("/responses")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ data: [], models: [] }));
			}
			seen.push({ path, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
			const item = {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "codex says hello", annotations: [] }],
			};
			const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
			const resp = { id: "resp_1", object: "response", status: "completed", output: [item], usage };
			res.writeHead(200, { "content-type": "text/event-stream" });
			const ev = (type: string, data: unknown): void => {
				res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
			};
			ev("response.created", { response: { ...resp, status: "in_progress", output: [] } });
			ev("response.output_item.done", { output_index: 0, item });
			ev("response.completed", { response: resp });
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		seen,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

describe("codex via mock provider", () => {
	it("sends a Responses request to the mock provider and prints the answer", async (ctx) => {
		const missing = codexMissing();
		if (missing) return ctx.skip(missing);
		const stub = await responsesStub();
		const session = await codexAdapter().start({ gatewayUrl: stub.url });
		try {
			const run = await session.run("say hello");
			const b = stub.seen[0]?.body as
				| { instructions?: string; input?: { role?: string }[]; tools?: unknown[] }
				| undefined;
			const sys = (b?.input ?? []).filter((m) => m.role === "developer" || m.role === "system");
			console.info(
				`[codex] ${JSON.stringify({
					requests: stub.seen.length,
					path: stub.seen[0]?.path,
					instructionsBytes: Buffer.byteLength(b?.instructions ?? ""),
					systemInputBytes: Buffer.byteLength(JSON.stringify(sys)),
					toolCount: b?.tools?.length,
					requestBytes: stub.seen.map((s) => Buffer.byteLength(JSON.stringify(s.body))),
					streamed: stub.seen.map((s) => s.body.stream),
					exitCode: run.exitCode,
					durationMs: run.durationMs,
				})}`,
			);
			expect(stub.seen.length).toBeGreaterThanOrEqual(1);
			expect(stub.seen[0].path).toBe("/v1/responses");
			expect(run.stdout).toContain("codex says hello");
		} finally {
			await session.close();
			await stub.close();
		}
	}, 150_000);
});
