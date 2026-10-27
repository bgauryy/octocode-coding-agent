import type { JsonValue } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@octocodeai/octocode-ai/utils/validation";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { waitForServers } from "../src/connections.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { McpServerConnection } from "../src/runtime.ts";
import type { McpServer } from "../src/server.ts";
import type { McpExtensionState } from "../src/state.ts";
import { toParameters } from "../src/tools.ts";

const never = () => new Promise<never>(() => {});

function hangingTransport() {
	return {
		start: never,
		send: async () => {},
		close: async () => {},
		onMessage: () => () => {},
		onClose: () => () => {},
		onError: () => () => {},
	} as never;
}

function workingTransport() {
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
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return pair.client;
}

describe("reconnect while a connect is hanging", () => {
	it("aborts the hung connect instead of waiting out its request timeout", async () => {
		const transports = [hangingTransport, workingTransport];
		let opened = 0;
		const connection = new McpServerConnection({
			entry: { name: "hang", source: "test", config: { command: "unused", timeout: 30 } },
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		const first = connection.getClient().then(
			() => "connected",
			() => "failed",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = Date.now();
		await connection.reconnect();
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(await first).toBe("failed");
		expect(opened).toBe(2);
		expect(connection.state).toBe("connected");
		await connection.close();
	});
});

describe("waitForServers", () => {
	const server = (name: string, ready: Promise<void> | undefined) =>
		({ entry: { name, source: "test", config: { command: "unused" } }, ready }) as McpServer;
	const stateOf = (servers: McpServer[]) => ({ servers }) as unknown as McpExtensionState;

	it("stops at its deadline and reports the servers still pending", async () => {
		const slow = server("slow", never());
		const fast = server("fast", Promise.resolve());
		const started = Date.now();
		const pending = await waitForServers(stateOf([slow, fast]), [slow, fast], undefined, 50);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(pending).toEqual([slow]);
	});

	it("reports nothing pending when every server settles in time", async () => {
		const a = server("a", new Promise<void>((resolve) => setTimeout(resolve, 10)));
		expect(await waitForServers(stateOf([a]), [a], undefined, 1_000)).toEqual([]);
	});
});

describe("tool input schemas with unresolvable references", () => {
	const call = (schema: Record<string, unknown>, args: Record<string, JsonValue>) =>
		validateToolArguments(
			{ name: "t", description: "", parameters: toParameters(schema) },
			{ type: "toolCall", id: "1", name: "t", arguments: args },
		);

	it("keeps a tool callable when a property references a remote or missing definition", () => {
		expect(call({ type: "object", properties: { a: { $ref: "https://example.com/x.json" } } }, { a: 1 })).toEqual({
			a: 1,
		});
		expect(call({ type: "object", properties: { a: { $ref: "#/definitions/Missing" } } }, { a: "x" })).toEqual({
			a: "x",
		});
	});

	it("still enforces the rest of the schema and resolves references that exist", () => {
		const schema = {
			type: "object",
			properties: { a: { $ref: "#/$defs/Name" }, b: { $ref: "https://example.com/x.json" } },
			required: ["a"],
			$defs: { Name: { type: "string" } },
		};
		expect(call(schema, { a: "ok", b: 1 })).toEqual({ a: "ok", b: 1 });
		expect(() => call(schema, { a: { nested: true } })).toThrow();
		expect(() => call(schema, {})).toThrow();
	});

	it("does not treat a $ref key inside data keywords or property names as a reference", () => {
		const schema = {
			type: "object",
			properties: { $ref: { type: "string" }, kind: { const: { $ref: "x" } } },
		};
		expect(call(schema, { $ref: "v", kind: { $ref: "x" } })).toEqual({ $ref: "v", kind: { $ref: "x" } });
		expect(() => call(schema, { $ref: { nested: true } })).toThrow();
	});
});
