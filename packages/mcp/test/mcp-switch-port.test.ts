import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/features/types.ts";
import { createMcpExtension } from "../src/index.ts";
import { getMcpSessionStatus } from "../src/status.ts";
import { getMcpSwitch } from "../src/switch.ts";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";

it("switches a server through the session port: persists, closes and reconnects without a reload", async () => {
	const servers: Array<ReturnType<typeof createInMemoryTransportPair>> = [];
	const transport = () => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "fixture", version: "1" },
						}
					: { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		void pair.server.start();
		servers.push(pair);
		return pair.client;
	};
	const writes: unknown[] = [];
	let api!: ExtensionAPI;
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			createMcpExtension({
				loadConfig: () => ({
					servers: [{ name: "fixture", config: { command: "unused" }, source: "/fixture/mcp.json" }],
					errors: [],
					globalConfig: "/fixture/mcp.json",
				}),
				createTransport: transport,
				updateConfig: (entry, patch) => void writes.push({ name: entry.name, patch }),
			}),
			(host) => {
				api = host;
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const switchServer = getMcpSwitch(api.events);
		expect(switchServer).toBeDefined();

		const off = await switchServer!({ name: "fixture", enabled: false, inProject: false });
		expect(off).toMatchObject({ ok: true });
		expect(off.message).toMatch(/^fixture: disabled · .*Saved to \/fixture\/mcp\.json\.$/);
		expect(getMcpSessionStatus(api.events).find((server) => server.name === "fixture")).toMatchObject({
			enabled: false,
		});

		const on = await switchServer!({ name: "fixture", enabled: true, inProject: false });
		expect(on.message).toMatch(/^fixture: enabled · /);
		expect(writes).toEqual([
			{ name: "fixture", patch: { enabled: false } },
			{ name: "fixture", patch: { enabled: true } },
		]);
		// Switching back on connects without a reload.
		await vi.waitFor(() =>
			expect(getMcpSessionStatus(api.events).find((server) => server.name === "fixture")).toMatchObject({
				enabled: true,
				state: "connected",
			}),
		);
		expect(servers.length).toBeGreaterThanOrEqual(1);

		expect(await switchServer!({ name: "missing", enabled: false, inProject: false })).toEqual({
			ok: false,
			message: 'No MCP server named "missing".',
		});
		// No trusted project in the harness: a project override is refused, not written elsewhere.
		expect(await switchServer!({ name: "fixture", enabled: false, inProject: true })).toMatchObject({ ok: false });
	} finally {
		harness.cleanup();
	}
});
