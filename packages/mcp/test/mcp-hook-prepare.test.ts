import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { expect, it } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/features/types.ts";
import { getMcpHookCaller } from "../src/hook-caller.ts";
import { createMcpExtension } from "../src/index.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";
import { convertMcpResult } from "../src/tools.ts";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";

it("runs a hook call through the preset's prepare and review, and a refusal rejects it", async () => {
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
						serverInfo: { name: "guarded", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "open", inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: "raw" }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	let api!: ExtensionAPI;
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			createMcpExtension({
				loadConfig: () => ({
					servers: [{ name: "guarded", config: { command: "unused" }, source: "fixture" }],
					errors: [],
					globalConfig: "fixture",
				}),
				createTransport: () => pair.client,
				presets: [
					{
						name: "guarded",
						defineTool: (options) =>
							createMcpToolDefinition({
								...options,
								presentation: {
									display: () => ({ title: "t", kind: "other", blocks: [] }),
									renderCall: (() => undefined) as never,
									renderResult: (() => undefined) as never,
									prepareCall: (args) => {
										if (args.refuse) throw new Error("blocked by the guard");
										return {
											args: { ...args, proxied: true },
											review: (result) => ({ ...result, content: [{ type: "text", text: "reviewed" }] }),
										};
									},
									convertResult: async (result) => convertMcpResult("guarded", "open", result),
								},
							}),
					},
				],
			}),
			(host) => {
				api = host;
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const call = getMcpHookCaller(api.events)!;
		const base = { server: "guarded", tool: "open", signal: new AbortController().signal, waitForConnection: true };
		const authorize = async () => {};
		const result = await call({ ...base, input: { url: "x" }, authorize });
		expect(result.content).toEqual([{ type: "text", text: "reviewed" }]);
		expect(calls).toEqual([
			{ name: "open", arguments: { url: "x", proxied: true }, _meta: { progressToken: expect.any(Number) } },
		]);
		await expect(call({ ...base, input: { refuse: true }, authorize })).rejects.toThrow("blocked by the guard");
		expect(calls).toHaveLength(1);
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});
