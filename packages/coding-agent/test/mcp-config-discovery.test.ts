import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";
import { loadMcpConfig, updateMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { configuredOctocodeServer, OctocodeMcp } from "../src/octocode/mcp/octocode.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "octocode-mcp-discovery-"));
	roots.push(root);
	const options = { cwd: join(root, "project"), agentDir: join(root, "home"), projectTrusted: true };
	mkdirSync(options.cwd);
	mkdirSync(options.agentDir);
	const write = (file: string, servers: Record<string, unknown>) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ mcpServers: servers }));
	};
	return { options, write };
}

describe("shared MCP discovery", () => {
	it("never starts the native server when MCP is disabled for the session", async () => {
		const { options } = setup();
		const server = new OctocodeMcp(
			{
				registerTool: () => {
					throw new Error("Unexpected registration");
				},
			},
			{
				enabled: false,
				launch: () => {
					throw new Error("Unexpected process");
				},
			},
		);
		expect(server.owner({ cwd: options.cwd, isProjectTrusted: () => true })).toEqual({ by: "off" });
		expect(server.describe()).toContain("disabled for this session");
		await server.close();
	});
	it.each([".pi/mcp.json", ".mcp.json", ".agents/mcp.json", ".octocode/mcp.json"])(
		"loads %s only after trust and shares ownership with the built-in client",
		(relative) => {
			const { options, write } = setup();
			write(join(options.cwd, relative), { octocode: { command: "server", enabled: false } });
			expect(hasTrustRequiringProjectResources(options.cwd)).toBe(true);
			expect(loadMcpConfig({ ...options, projectTrusted: false }).servers).toEqual([]);
			expect(configuredOctocodeServer(options.cwd, false, options.agentDir)).toBeUndefined();
			const loaded = loadMcpConfig(options);
			expect(loaded.errors).toEqual([]);
			expect(loaded.servers).toHaveLength(1);
			expect(configuredOctocodeServer(options.cwd, true, options.agentDir)).toEqual(loaded.servers[0].config);
		},
	);
	it("uses native project settings last without merging transport credentials", () => {
		const { options, write } = setup();
		write(join(options.agentDir, "mcp.json"), { octocode: { command: "global", env: { TOKEN: "global-only" } } });
		write(join(options.cwd, ".mcp.json"), { octocode: { command: "shared" } });
		write(join(options.cwd, ".agents/mcp.json"), { octocode: { command: "agents" } });
		write(join(options.cwd, ".octocode/mcp.json"), { octocode: { enabled: false } });
		expect(loadMcpConfig(options).servers[0].config).toEqual({ command: "agents", enabled: false });
	});
	it("loads JSON comments and trailing commas and persists management changes", () => {
		const { options } = setup();
		const file = join(options.cwd, ".mcp.json");
		writeFileSync(file, '\uFEFF{ // shared config\n "mcpServers": { "octocode": {"command":"server",},},}');
		expect(loadMcpConfig(options).servers).toHaveLength(1);
		updateMcpServerConfig(file, "octocode", { enabled: false });
		expect(loadMcpConfig(options).servers[0].config.enabled).toBe(false);
	});
	it("rejects credential forwarding in every project source", () => {
		const { options, write } = setup();
		write(join(options.cwd, ".mcp.json"), {
			private: { url: "https://example.test/mcp", auth: { provider: "openai" } },
		});
		const loaded = loadMcpConfig(options);
		expect(loaded.servers).toEqual([]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain("auth is only allowed in the global mcp.json");
	});
});
