import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { McpServerConnection } from "../src/runtime.ts";
import { describeState } from "../src/server.ts";

/** Starts but never answers `initialize`: the request times out. */
function silentTransport() {
	return {
		start: async () => {},
		send: async () => {},
		close: async () => {},
		onMessage: () => () => {},
		onClose: () => () => {},
		onError: () => () => {},
	} as never;
}

/** Answers every request after `delayMs`, like a server slow to start under load. */
function slowTransport(delayMs: number) {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: { tools: [] };
		setTimeout(() => void pair.server.send({ jsonrpc: "2.0", id: message.id, result }), delayMs);
	});
	void pair.server.start();
	return pair.client;
}

function connectionWith(timeoutSeconds: number, transports: Array<() => never>) {
	const opened = { count: 0 };
	const connection = new McpServerConnection({
		entry: { name: "slow", source: "test", config: { command: "unused", timeout: timeoutSeconds } },
		cwd: process.cwd(),
		createTransport: () => {
			const open = transports[Math.min(opened.count++, transports.length - 1)];
			return open();
		},
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: () => {},
	});
	return { connection, opened };
}

const stateText = (connection: McpServerConnection) => describeState({ entry: connection.entry, connection }, true);

describe("MCP startup timeout", () => {
	it("retries a start that timed out once with a longer timeout, and says so in the state", async () => {
		// 0.1 s bound: the first attempt times out; the second has 0.2 s and a server that answers after 0.15 s.
		const { connection, opened } = connectionWith(0.1, [silentTransport, () => slowTransport(150) as never]);
		await connection.getClient();
		expect(opened.count).toBe(2);
		expect(connection.state).toBe("connected");
		expect(connection.retriedAfterTimeout).toBe(true);
		expect(stateText(connection)).toBe("connected · 0 tools (retried after timeout)");
		await connection.close();
	});

	it("does not retry a start that succeeds, and shows no retry", async () => {
		const { connection, opened } = connectionWith(0.5, [() => slowTransport(0) as never]);
		await connection.getClient();
		expect(opened.count).toBe(1);
		expect(connection.retriedAfterTimeout).toBe(false);
		expect(stateText(connection)).not.toContain("retried");
		await connection.close();
	});

	it("fails a server that never answers after the one retry", async () => {
		const { connection, opened } = connectionWith(0.1, [silentTransport]);
		const started = Date.now();
		await expect(connection.getClient()).rejects.toThrow(/timed out after 200ms/);
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
		expect(opened.count).toBe(2);
		expect(connection.state).toBe("failed");
		expect(stateText(connection)).toContain("(retried after timeout)");
		await connection.close();
	});

	it("does not retry other failures", async () => {
		const failing = () =>
			({
				start: async () => {
					throw new Error("spawn failed");
				},
				send: async () => {},
				close: async () => {},
				onMessage: () => () => {},
				onClose: () => () => {},
				onError: () => () => {},
			}) as never;
		const { connection, opened } = connectionWith(0.1, [failing]);
		await expect(connection.getClient()).rejects.toThrow(/spawn failed/);
		expect(opened.count).toBe(1);
		expect(connection.retriedAfterTimeout).toBe(false);
		await connection.close();
	});
});
