import "../mcp-host.ts";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../../mcp/src/config.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";
import { createSandbox, type Sandbox, write } from "../discovery/fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	installOctocodeDiscovery();
	write(join(sandbox.agentDir, "settings.json"), JSON.stringify({ toggles: { "harness:codex": true } }));
});
afterEach(() => sandbox.cleanup());

const discover = () =>
	configDiscovery.discover(
		"mcp",
		discoveryInput({
			cwd: sandbox.cwd,
			agentDir: sandbox.agentDir,
			projectTrusted: true,
			toggles: { "harness:codex": true },
		}),
	);

describe("a foreign MCP server that launches what another loaded server launches", () => {
	const octocodeFile = () =>
		write(
			join(sandbox.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "npx", args: ["octocode-x", "--stdio"] } } }),
		);
	const codexFile = () =>
		write(
			join(sandbox.home, ".codex", "config.toml"),
			[
				"[mcp_servers.octocode-2]",
				'command = "npx"',
				'args = ["octocode-x", "--stdio"]',
				"[mcp_servers.other]",
				'command = "npx"',
				'args = ["octocode-x", "--other"]',
			].join("\n"),
		);

	it("is listed as shadowed by the file of the server that loads, as the loader drops it; a different launch stays loaded", () => {
		const winner = octocodeFile();
		codexFile();
		const items = discover();
		const state = (name: string) => items.find((item) => item.name === name);
		expect(state("octocode")).toMatchObject({ loaded: true });
		expect(state("octocode-2")).toMatchObject({ loaded: false, provenance: { shadowedBy: { path: winner } } });
		expect(state("other")).toMatchObject({ loaded: true });
		const loaded = loadMcpConfig({ agentDir: sandbox.agentDir, cwd: sandbox.cwd, projectTrusted: true });
		expect(loaded.servers.map((server) => server.name).sort()).toEqual(["octocode", "other"]);
	});
});
