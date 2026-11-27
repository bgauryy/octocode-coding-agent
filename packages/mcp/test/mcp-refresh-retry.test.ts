import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { McpServerConnection } from "../src/runtime.ts";
import { REFRESH_RETRY_DELAYS_MS } from "../src/runtime/refresh-retry.ts";

/** A server whose `tools/list` call number `n` fails when `failing(n)` is true. */
function fakeServer(failing: (call: number) => boolean) {
	const pair = createInMemoryTransportPair();
	const state = { lists: 0 };
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		if (message.method === "initialize") {
			void pair.server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "fake", version: "1" },
				},
			});
		} else if (message.method === "tools/list") {
			const call = ++state.lists;
			void pair.server.send(
				failing(call)
					? { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "boom" } }
					: {
							jsonrpc: "2.0",
							id: message.id,
							result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
						},
			);
		}
	});
	void pair.server.start();
	const changed = () => void pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as never);
	return { transport: pair.client, state, changed };
}

function connect(server: ReturnType<typeof fakeServer>) {
	return new McpServerConnection({
		entry: { name: "fake", source: "test", config: { command: "unused" } },
		cwd: process.cwd(),
		createTransport: () => server.transport,
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: () => {},
	});
}

afterEach(() => vi.useRealTimers());

describe("MCP tools/list refresh retry", () => {
	it("restores the tools after a failed refresh without reconnecting, and leaves no timer after close", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const server = fakeServer((call) => call === 2);
		const connection = connect(server);
		await connection.getClient();
		expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);

		server.changed();
		await vi.waitFor(() => expect(server.state.lists).toBe(2));
		await vi.waitFor(() => expect(connection.error).toContain("Failed to refresh tools: "));
		expect(connection.tools).toEqual([]);
		expect(connection.state).toBe("connected");
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(REFRESH_RETRY_DELAYS_MS[0]);
		await vi.waitFor(() => expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]));
		expect(connection.error).toBeUndefined();
		expect(connection.state).toBe("connected");
		expect(server.state.lists).toBe(3);
		expect(vi.getTimerCount()).toBe(0);
		await connection.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives up after the bounded retries and clears a pending retry on close", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const server = fakeServer((call) => call > 1);
		const connection = connect(server);
		await connection.getClient();
		server.changed();
		await vi.waitFor(() => expect(connection.error).toContain("Failed to refresh tools"));
		for (const delay of REFRESH_RETRY_DELAYS_MS) {
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(delay);
			await vi.waitFor(() => expect(vi.getTimerCount()).toBeLessThanOrEqual(1));
		}
		await vi.waitFor(() => expect(server.state.lists).toBe(1 + 1 + REFRESH_RETRY_DELAYS_MS.length));
		expect(vi.getTimerCount()).toBe(0);
		expect(connection.tools).toEqual([]);

		const pending = fakeServer((call) => call > 1);
		const second = connect(pending);
		await second.getClient();
		pending.changed();
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
		await second.close();
		expect(vi.getTimerCount()).toBe(0);
		await connection.close();
	});
});
