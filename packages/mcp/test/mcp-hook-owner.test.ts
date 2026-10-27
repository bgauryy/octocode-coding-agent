import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION, McpSessionExpiredError } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { getMcpHookCaller } from "../src/hook-caller.ts";
import { createMcpExtension } from "../src/index.ts";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";

const authorize = async () => {};

it("uses the configured MCP connection for hook calls without recursive tool events", async () => {
	const pair = createInMemoryTransportPair();
	const calls: unknown[] = [];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		if (message.method === "tools/call") calls.push(message.params);
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "policy", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: '{"decision":"block","reason":"policy"}' }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	let api!: ExtensionAPI;
	let recursive = 0;
	const authorized: unknown[] = [];
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", () => {
					recursive++;
				});
				return createMcpExtension({
					loadConfig: () => ({
						servers: [{ name: "policy", config: { command: "unused" }, source: "fixture" }],
						errors: [],
						globalConfig: "fixture",
					}),
					createTransport: () => pair.client,
				})(pi);
			},
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const call = getMcpHookCaller(api.events);
		expect(call).toBeDefined();
		const result = await call!({
			server: "policy",
			tool: "check",
			input: { path: "a.txt" },
			signal: new AbortController().signal,
			waitForConnection: true,
			authorize: async (call) => {
				authorized.push(call);
			},
		});
		expect(result.content).toEqual([{ type: "text", text: '{"decision":"block","reason":"policy"}' }]);
		expect(calls).toEqual([{ name: "check", arguments: { path: "a.txt" } }]);
		expect(authorized).toEqual([{ toolName: "mcp__policy__check", input: { path: "a.txt" } }]);
		expect(recursive).toBe(0);
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			call!({
				server: "policy",
				tool: "check",
				input: {},
				signal: cancelled.signal,
				waitForConnection: true,
				authorize,
			}),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
		await expect(
			call!({
				server: "missing",
				tool: "check",
				input: {},
				signal: new AbortController().signal,
				waitForConnection: false,
				authorize,
			}),
		).rejects.toThrow("unavailable");
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});

it("refuses a hook call the host's gate refuses, and a tool that is hidden or not offered, before the server is called", async () => {
	const pair = createInMemoryTransportPair();
	const calls: unknown[] = [];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		if (message.method === "tools/call") calls.push(message.params);
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "db", version: "1" },
					}
				: message.method === "tools/list"
					? {
							tools: [
								{ name: "drop", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
								{ name: "secret", inputSchema: { type: "object" } },
							],
						}
					: { content: [{ type: "text", text: "ok" }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	let api!: ExtensionAPI;
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			createMcpExtension({
				loadConfig: () => ({
					servers: [
						{ name: "db", config: { command: "unused", toolExposure: { secret: "hidden" } }, source: "fixture" },
					],
					errors: [],
					globalConfig: "fixture",
				}),
				createTransport: () => pair.client,
			}),
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const call = getMcpHookCaller(api.events)!;
		const request = (tool: string, authorize: (call: { toolName: string }) => Promise<void>) =>
			call({
				server: "db",
				tool,
				input: { table: "users" },
				signal: new AbortController().signal,
				waitForConnection: true,
				authorize,
			});
		const refusal = vi.fn(async () => {
			throw new Error("permission refused");
		});
		await expect(request("drop", refusal)).rejects.toThrow("permission refused");
		expect(refusal).toHaveBeenCalledWith({ toolName: "mcp__db__drop", input: { table: "users" } });
		const never = vi.fn(async () => {});
		await expect(request("secret", never)).rejects.toThrow("not available");
		await expect(request("absent", never)).rejects.toThrow("not available");
		expect(never).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});

it("runs a hook call through the connection's request path, retrying once on an expired session", async () => {
	const calls: unknown[] = [];
	const transport = (expireCalls: boolean) => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			if (message.method === "tools/call") calls.push(message.params);
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "policy", version: "1" },
						}
					: message.method === "tools/list"
						? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: "fresh session" }] };
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		void pair.server.start();
		if (expireCalls) {
			const send = pair.client.send.bind(pair.client);
			// The HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	};
	const transports = [transport(true), transport(false)];
	let opened = 0;
	let api!: ExtensionAPI;
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			createMcpExtension({
				loadConfig: () => ({
					servers: [{ name: "policy", config: { command: "unused" }, source: "fixture" }],
					errors: [],
					globalConfig: "fixture",
				}),
				createTransport: () => transports[opened++],
			}),
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const result = await getMcpHookCaller(api.events)!({
			server: "policy",
			tool: "check",
			input: {},
			signal: new AbortController().signal,
			waitForConnection: true,
			authorize,
		});
		expect(result.content).toEqual([{ type: "text", text: "fresh session" }]);
		expect(opened).toBe(2);
		expect(calls).toHaveLength(1);
	} finally {
		harness.cleanup();
		await Promise.all(transports.map((transport) => transport.close()));
	}
});
