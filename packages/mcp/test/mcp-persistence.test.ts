import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMcpServerPatch, getMcpToolExposure, type McpServerEntry, updateMcpServerConfig } from "../src/config.ts";
import { saveConfig } from "../src/persistence.ts";
import type { McpServer } from "../src/server.ts";
import type { McpExtensionState } from "../src/state.ts";

describe("saveConfig", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function setup(entry: Partial<McpServerEntry>) {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-persistence-"));
		dirs.push(dir);
		const file = join(dir, "mcp.json");
		writeFileSync(file, JSON.stringify({ mcpServers: { octocode: { command: "octocode-mcp", exposure: "hidden" } } }));
		const server: McpServer = {
			entry: {
				name: "octocode",
				config: { command: "octocode-mcp", exposure: "hidden" },
				source: file,
				scope: "global",
				...entry,
			},
		};
		const state = {
			projectConfig: undefined,
			configuredEntries: [server.entry],
			configPath: (found: McpServerEntry) => found.override ?? found.source,
			updateConfig: (found: McpServerEntry, patch: Parameters<typeof updateMcpServerConfig>[2]) =>
				updateMcpServerConfig(found.override ?? found.source, found.name, patch, {
					override: found.override !== undefined,
				}),
		} as unknown as McpExtensionState;
		return { server, state, file };
	}

	it("keeps the session's configuration equal to the file when a default removes its key", () => {
		const { server, state, file } = setup({});
		expect(getMcpToolExposure(server.entry.config, "localSearchCode")).toBe("hidden");
		expect(saveConfig(state, server, { exposure: "direct" })).toBeUndefined();
		expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.octocode).toEqual({ command: "octocode-mcp" });
		expect(server.entry.config.exposure).toBeUndefined();
		// Without an explicit exposure all Octocode tools are direct again.
		expect(getMcpToolExposure(server.entry.config, "localSearchCode")).toBe("direct");
		expect(getMcpToolExposure(server.entry.config, "ghSearchCode")).toBe("direct");
	});

	it("persists a non-default setting next to an explicit exposure", () => {
		const { server, state, file } = setup({});
		expect(saveConfig(state, server, { enabled: false })).toBeUndefined();
		expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.octocode).toEqual({
			command: "octocode-mcp",
			exposure: "hidden",
			enabled: false,
		});
		expect(server.entry.config.enabled).toBe(false);
	});

	it("keeps explicit defaults in an override, as the file does", () => {
		const { server, state, file } = setup({ override: undefined });
		const overrideFile = join(file, "..", "override.json");
		writeFileSync(overrideFile, JSON.stringify({ mcpServers: { octocode: { exposure: "hidden" } } }));
		server.entry = { ...server.entry, override: overrideFile, overrideScope: "project" };
		expect(saveConfig(state, server, { exposure: "direct" })).toBeUndefined();
		expect(JSON.parse(readFileSync(overrideFile, "utf8")).mcpServers.octocode).toEqual({ exposure: "direct" });
		expect(server.entry.config.exposure).toBe("direct");
	});
});

describe("defaultActive persistence", () => {
	it("stores false and removes the key for the default", () => {
		const server: { defaultActive?: unknown } = {};
		applyMcpServerPatch(server, { defaultActive: false }, false);
		expect(server).toEqual({ defaultActive: false });
		applyMcpServerPatch(server, { defaultActive: true }, false);
		expect(server).toEqual({});
		applyMcpServerPatch(server, { defaultActive: true }, true);
		expect(server).toEqual({ defaultActive: true });
	});
});
