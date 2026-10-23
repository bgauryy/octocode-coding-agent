import { LATEST_PROTOCOL_VERSION } from "@octocodeai/octocode-mcp";
import { createInMemoryTransportPair } from "@octocodeai/octocode-mcp/testing";
import { expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { getMcpHookCaller } from "../src/extensions/mcp/hook-caller.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { createHarness } from "./suite/harness.ts";

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
		});
		expect(result.content).toEqual([{ type: "text", text: '{"decision":"block","reason":"policy"}' }]);
		expect(calls).toEqual([{ name: "check", arguments: { path: "a.txt" } }]);
		expect(recursive).toBe(0);
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			call!({ server: "policy", tool: "check", input: {}, signal: cancelled.signal, waitForConnection: true }),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
		await expect(
			call!({
				server: "missing",
				tool: "check",
				input: {},
				signal: new AbortController().signal,
				waitForConnection: false,
			}),
		).rejects.toThrow("unavailable");
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});
