import { LATEST_PROTOCOL_VERSION, type JsonRpcMessage } from "@octocodeai/octocode-mcp";
import { createInMemoryTransportPair } from "@octocodeai/octocode-mcp/testing";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";
import { describe, expect, it, vi } from "vitest";
import { McpCatalogCache } from "../src/extensions/mcp/catalog.ts";

const tool = (description = "Read a file") => ({
	name: "read",
	description,
	inputSchema: { type: "object" as const, properties: { path: { type: "string" } } },
});

describe("validated MCP catalog cache", () => {
	it("reuses tool and list identity, preserving instructions and complete schemas", () => {
		const cache = new McpCatalogCache();
		const first = cache.update({ name: "files", version: "1" }, [tool()], "Use exact paths");
		const next = cache.update({ version: "1", name: "files" }, [tool()], "Use exact paths");
		expect(next.tools).toBe(first.tools);
		expect(next.instructions).toBe("Use exact paths");
		expect(next.tools[0]?.inputSchema).toBe(first.tools[0]?.inputSchema);
	});

	it("keeps the published order when the server only reorders unchanged definitions", () => {
		const cache = new McpCatalogCache();
		const first = cache.update("server", [tool(), { ...tool(), name: "other" }], undefined);
		const reordered = cache.update("server", [{ ...tool(), name: "other" }, tool()], undefined);
		expect(reordered.tools).toBe(first.tools);
	});

	it("replaces changed descriptions, schemas and server identity while keeping unaffected tools", () => {
		const cache = new McpCatalogCache();
		const first = cache.update("server", [tool(), { ...tool(), name: "other" }], "old instructions");
		const changed = cache.update("server", [tool("New description"), { ...tool(), name: "other" }], "new instructions");
		expect(changed.tools[0]).not.toBe(first.tools[0]);
		expect(changed.tools[1]).toBe(first.tools[1]);
		expect(changed.instructions).toBe("new instructions");
		const schema = cache.update(
			"server",
			[{ ...tool("New description"), inputSchema: { type: "object", required: ["path"] } }],
			"new instructions",
		);
		expect(schema.tools[0]).not.toBe(changed.tools[0]);
		const replacement = cache.update("other server", [tool()], undefined);
		expect(replacement.tools[0]).not.toBe(first.tools[0]);
		cache.clear();
		expect(cache.update("other server", [tool()], undefined).tools[0]).not.toBe(replacement.tools[0]);
	});
});

function connectionFixture() {
	const peers: ReturnType<typeof createInMemoryTransportPair>["server"][] = [];
	const requests: { peer: (typeof peers)[number]; request: JsonRpcMessage & { id: string | number } }[] = [];
	const published: string[][] = [];
	let version = "1";
	let hold = false;
	const connection = new McpServerConnection({
		entry: { name: "catalog", config: { command: "unused" }, source: "test" },
		cwd: process.cwd(),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: (current) => published.push(current.tools.map((item) => item.name)),
		createTransport: () => {
			const pair = createInMemoryTransportPair();
			peers.push(pair.server);
			pair.server.onMessage((message) => {
				if (!("id" in message) || !("method" in message)) return;
				if (message.method === "tools/list" && hold) {
					requests.push({ peer: pair.server, request: message });
					return;
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: { listChanged: true } },
								serverInfo: { name: "catalog", version },
								instructions: "Use exact paths",
							}
						: { tools: [tool()] };
				queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: message.id, result }));
			});
			void pair.server.start();
			return pair.client;
		},
	});
	return {
		connection,
		published,
		requests,
		version: (value: string) => {
			version = value;
		},
		hold: () => {
			hold = true;
		},
		notify: () => peers.at(-1)!.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
	};
}

describe("MCP connection catalog lifecycle", () => {
	it("does not connect or publish a disabled server", async () => {
		const fixture = connectionFixture();
		fixture.connection.entry.config.enabled = false;
		await expect(fixture.connection.getClient()).rejects.toThrow("disabled");
		expect(fixture.published).toEqual([]);
		await fixture.connection.close();
	});
	it("suppresses unchanged refreshes, validates reconnects and withdraws closed catalogs", async () => {
		const fixture = connectionFixture();
		const { connection } = fixture;
		try {
			await connection.getClient();
			const tools = connection.tools;
			await fixture.notify();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(connection.tools).toBe(tools);
			expect(fixture.published).toEqual([["read"]]);
			await connection.reconnect();
			expect(connection.tools).toBe(tools);
			expect(fixture.published).toEqual([["read"], [], ["read"]]);
			fixture.version("2");
			await connection.reconnect();
			expect(connection.tools[0]).not.toBe(tools[0]);
		} finally {
			await connection.close();
		}
		expect(connection.tools).toEqual([]);
		expect(connection.instructions).toBeUndefined();
	});

	it("ignores out-of-order replies and withdraws the catalog when its latest refresh fails", async () => {
		const fixture = connectionFixture();
		const { connection, requests } = fixture;
		try {
			await connection.getClient();
			fixture.hold();
			await fixture.notify();
			await fixture.notify();
			await vi.waitFor(() => expect(requests).toHaveLength(2));
			await requests[1]!.peer.send({
				jsonrpc: "2.0",
				id: requests[1]!.request.id,
				result: { tools: [{ ...tool(), name: "new" }] },
			});
			await vi.waitFor(() => expect(connection.tools[0]?.name).toBe("new"));
			await requests[0]!.peer.send({
				jsonrpc: "2.0",
				id: requests[0]!.request.id,
				error: { code: -32000, message: "old failure" },
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(connection.tools[0]?.name).toBe("new");
			expect(connection.error).toBeUndefined();
			await fixture.notify();
			await vi.waitFor(() => expect(requests).toHaveLength(3));
			await requests[2]!.peer.send({
				jsonrpc: "2.0",
				id: requests[2]!.request.id,
				error: { code: -32000, message: "latest failure" },
			});
			await vi.waitFor(() => expect(connection.tools).toEqual([]));
			expect(connection.instructions).toBeUndefined();
			expect(connection.error).toContain("latest failure");
		} finally {
			await connection.close();
		}
	});
});
