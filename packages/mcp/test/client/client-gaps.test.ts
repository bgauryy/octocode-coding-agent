import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, type JsonRpcMessage, type JsonRpcRequest } from "../../src/client/index.ts";
import { createInMemoryTransportPair } from "../../src/client/testing/index.ts";
import { McpServerLog } from "../../src/log.ts";
import { DEFAULT_TIMEOUT_MS, createMcpClient, trackServerWarnings } from "../../src/runtime/client.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A connected client whose server records `tools/call` requests and `notifications/cancelled`. */
async function connect(client: McpClient) {
	const pair = createInMemoryTransportPair();
	const calls: JsonRpcRequest[] = [];
	const cancelled: unknown[] = [];
	pair.server.onMessage((message: JsonRpcMessage) => {
		if (!("method" in message)) return;
		if (message.method === "notifications/cancelled") cancelled.push(message.params);
		if (!("id" in message)) return;
		if (message.method === "initialize")
			void pair.server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "test", version: "1" },
				},
			});
		else calls.push(message);
	});
	await pair.server.start();
	await client.connect(pair.client);
	return { server: pair.server, calls, cancelled };
}

describe("MCP client gaps", () => {
	it("keeps a call alive past the default idle timeout while the server sends progress", async () => {
		vi.useFakeTimers();
		const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: DEFAULT_TIMEOUT_MS });
		const { server, calls } = await connect(client);
		// The shape of a hook or extension call: a no-op progress handler makes the client send a progress token.
		const result = client.callTool("long", {}, { timeoutMs: DEFAULT_TIMEOUT_MS, onProgress: () => undefined });
		await vi.advanceTimersByTimeAsync(0);
		const request = calls[0];
		const token = (request.params as { _meta: { progressToken: number } })._meta.progressToken;
		for (let seconds = 10; seconds <= 90; seconds += 10) {
			await vi.advanceTimersByTimeAsync(10_000);
			await server.send({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: token, progress: seconds },
			});
		}
		await server.send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "done" }] } });
		await expect(result).resolves.toMatchObject({ content: [{ type: "text", text: "done" }] });
		await client.close();
	});

	it("times a silent call out at the default idle timeout", async () => {
		vi.useFakeTimers();
		const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: DEFAULT_TIMEOUT_MS });
		await connect(client);
		const result = client.callTool("silent", {}, { timeoutMs: DEFAULT_TIMEOUT_MS, onProgress: () => undefined });
		const rejected = expect(result).rejects.toMatchObject({ name: "McpTimeoutError" });
		await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
		await rejected;
		await client.close();
	});

	it("sends notifications/cancelled for the request when the caller's signal aborts", async () => {
		const client = new McpClient({ name: "test", version: "1" });
		const { calls, cancelled } = await connect(client);
		const controller = new AbortController();
		const result = client.callTool("slow", {}, { signal: controller.signal });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		controller.abort(new Error("stop"));
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(cancelled).toEqual([expect.objectContaining({ requestId: calls[0].id })]));
		await client.close();
	});

	it("reports a warning-level server message to the server's page and writes every level to mcp.log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
		dirs.push(dir);
		const log = new McpServerLog(join(dir, "mcp.log"));
		const { client, closeClient } = createMcpClient("srv", dir, 1000, log);
		const { server } = await connect(client);
		const lines: (string | undefined)[] = [];
		trackServerWarnings(client, (line) => lines.push(line));
		const notify = (level: string, data: string) =>
			server.send({ jsonrpc: "2.0", method: "notifications/message", params: { level, data } });
		await notify("info", "starting");
		await notify("warning", "disk\nnearly   full");
		await notify("error", "boom");
		await vi.waitFor(() => expect(lines).toEqual([undefined, "warning: disk nearly full", "error: boom"]));
		const written = readFileSync(log.path, "utf8");
		expect(written).toContain("[srv] info starting");
		expect(written).toContain("[srv] warning");
		expect(written).toContain("[srv] error boom");
		await closeClient();
	});
});
