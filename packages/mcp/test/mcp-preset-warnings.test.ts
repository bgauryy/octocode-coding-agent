import { afterEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import type { McpServerPreset } from "../src/preset.ts";
import { presetEntries } from "../src/preset.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

function workingTransport() {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "f", version: "1" },
					}
				: { tools: [] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return pair.client;
}

const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});

/** A host whose tool selection is the default one, as a main session's (`selects` follows `defaultActive`). */
function selectingHost(preset: McpServerPreset) {
	const host = mcpHost({ presets: [preset], servers: presetEntries([preset]), createTransport: workingTransport });
	Object.assign(host.api.tools, { selects: (_prefix: string, defaultActive: boolean) => defaultActive });
	hosts.push(host);
	return host;
}

/** A preset like the desktop's: its warnings probe the program behind the server (Cua Driver runs `--version`). */
function probingPreset(defaultActive: boolean) {
	const probes: string[] = [];
	const preset: McpServerPreset = {
		name: "probed",
		config: { command: "unused", defaultActive },
		takeWarnings: () => {
			probes.push("probe");
			return ["probed server warning"];
		},
	};
	return { preset, probes };
}

describe("preset warnings at the first prompt", () => {
	it("probes nothing for a preset server this session does not run (the main session and the desktop server)", async () => {
		const { preset, probes } = probingPreset(false);
		const host = selectingHost(preset);
		await host.start();
		await host.prompt();
		expect(host.state.findServer("probed")?.unselected).toBe(true);
		expect(probes).toEqual([]);
	});

	it("probes and tells the user when this session runs the preset's server", async () => {
		const { preset, probes } = probingPreset(true);
		const host = selectingHost(preset);
		await host.start();
		await host.prompt();
		expect(probes).toEqual(["probe"]);
		expect(host.ctx.ui.notes.map((note) => note.message).join("\n")).toContain("probed server warning");
	});
});
