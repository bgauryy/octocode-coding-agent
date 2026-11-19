import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { expect, it } from "vitest";
import { hostOutput } from "../src/host.ts";
import type { FeatureSetup } from "../../coding-agent/src/core/features/types.ts";
import { getMcpHookCaller } from "../src/hook-caller.ts";
import { createMcpFeature } from "../src/index.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";
import { convertMcpResult } from "../src/tools.ts";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { testFeatures } from "../../coding-agent/test/helpers/features.ts";

it("caps an oversized hook call result instead of returning it whole", async () => {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "guarded", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "open", inputSchema: { type: "object" } }] }
					: {
							content: [{ type: "text", text: "x".repeat(500_000) }],
							structuredContent: { rows: "y".repeat(500_000) },
						};
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	let api!: FeatureSetup;
	const harness = await createHarness({
		initialActiveToolNames: [],
		features: testFeatures([
			createMcpFeature({
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
		]),
	});
	try {
		await harness.session.bindFeatures({});
		const call = getMcpHookCaller(api.channels)!;
		const base = { server: "guarded", tool: "open", signal: new AbortController().signal, waitForConnection: true };
		const authorize = async () => {};
		const result = await call({ ...base, input: { url: "x" }, authorize });
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThanOrEqual(hostOutput().textMaxChars);
		expect(text.length).toBeLessThan(500_000);
		expect(JSON.stringify(result.structuredContent).length).toBeLessThan(1_000);
		expect(result.structuredContent).toMatchObject({ truncated: true, chars: expect.any(Number) });
	} finally {
		harness.cleanup();
		await pair.client.close();
		await pair.server.close();
	}
});
