import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../coding-agent/src/config.ts";
import { listMcpFileEntries, loadMcpConfig, type McpServerEntry } from "../src/config.ts";
import { mcpConfigFiles } from "../src/paths.ts";
import { presetEntries } from "../src/preset.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { requestMcpReload } from "../src/switch.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

/** An isolated home with a project folder, default Octocode layout (Pi compatibility on) and no vendor env. */
function setup() {
	const home = mkdtempSync(join(tmpdir(), "octocode-mcp-vendors-"));
	roots.push(home);
	for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, home);
	for (const name of ["OCTOCODE_HOME", "OCTOCODE_CODING_AGENT_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
		vi.stubEnv(name, "");
	const cwd = join(home, "project");
	mkdirSync(cwd);
	const agentDir = getAgentDir();
	const options = { agentDir, cwd, projectTrusted: true };
	const toggles = (value: Record<string, boolean>, file = join(agentDir, "settings.json")) =>
		write(file, { toggles: value });
	const names = (loaded: { servers: McpServerEntry[] }) => loaded.servers.map((entry) => entry.name).sort();
	return { home, cwd, agentDir, options, toggles, names };
}

const ALL_ON = { "harness:claude": true, "harness:codex": true, "harness:cursor": true };

function writeVendorFiles(home: string, cwd: string) {
	write(join(home, ".claude.json"), {
		mcpServers: {
			"claude-user": { command: "node", args: ["a.js"], env: { TOKEN: "${TOKEN}", BANG: "!literal" } },
			"claude-http": { type: "http", url: "https://example.com/mcp", headers: { X: "1" }, timeout: 1500 },
			"claude-sdk": { type: "sdk", name: "in-process" },
		},
		projects: {
			[cwd]: { mcpServers: { "claude-local": { command: "local" } } },
			[join(home, "elsewhere")]: { mcpServers: { "claude-other": { command: "other" } } },
		},
	});
	write(
		join(home, ".codex", "config.toml"),
		[
			"[mcp_servers.codex-stdio]",
			'command = "node"',
			'args = ["c.js"]',
			'cwd = "/tmp"',
			'env = { A = "1" }',
			'env_vars = ["PATH_VAR"]',
			'enabled_tools = ["read", "list"]',
			'disabled_tools = ["list"]',
			"tool_timeout_sec = 30",
			"",
			"[mcp_servers.codex-http]",
			'url = "https://codex.example/mcp"',
			'bearer_token_env_var = "CODEX_TOKEN"',
			'http_headers = { "X-Team" = "core" }',
			'env_http_headers = { "X-Key" = "KEY_VAR" }',
			"enabled = false",
		].join("\n"),
	);
	write(join(home, ".cursor", "mcp.json"), {
		mcpServers: {
			"cursor-user": {
				command: "${userHome}/bin/server",
				args: ["${workspaceFolder}", "${workspaceFolderBasename}", "${env:CURSOR_ARG}"],
				env: { KEY: "${env:CURSOR_SECRET}" },
			},
		},
	});
	write(join(cwd, ".codex", "config.toml"), '[mcp_servers.codex-project]\ncommand = "p"\n');
	write(join(cwd, ".cursor", "mcp.json"), { mcpServers: { "cursor-project": { url: "https://cursor.example/mcp" } } });
}

describe("MCP files of other agents", () => {
	it("lists every vendor file in precedence order, on or off", () => {
		const { home, cwd, agentDir } = setup();
		const files = mcpConfigFiles(agentDir, cwd).map((file) => [file.vendor, file.scope, file.format, file.path]);
		const claude = join(home, ".claude.json");
		expect(files.map(([vendor, scope]) => `${vendor}:${scope}`)).toEqual([
			"pi:global",
			"pi:global",
			"claude:global",
			"claude:global",
			"codex:global",
			"cursor:global",
			"octocode:global",
			"octocode:global",
			"octocode:global",
			"pi:project",
			"codex:project",
			"cursor:project",
			"mcp-json:project",
			"agents:project",
			"octocode:project",
		]);
		expect(files.slice(2, 6)).toEqual([
			["claude", "global", "claude-json", claude],
			["claude", "global", "claude-json", claude],
			["codex", "global", "codex-toml", join(home, ".codex", "config.toml")],
			["cursor", "global", "cursor-json", join(home, ".cursor", "mcp.json")],
		]);
		expect(mcpConfigFiles(agentDir, cwd)[3]).toMatchObject({ claudeProject: cwd, origin: "claude" });
		expect(files.find(([vendor]) => vendor === "mcp-json")?.[3]).toBe(join(cwd, ".mcp.json"));
	});

	it("leaves .pi/mcp.json out without Pi compatibility", () => {
		const { home, cwd } = setup();
		vi.stubEnv("OCTOCODE_HOME", join(home, "custom"));
		const files = mcpConfigFiles(getAgentDir(), cwd);
		expect(files.some((file) => file.vendor === "pi")).toBe(false);
		expect(files.filter((file) => file.scope === "project").map((file) => file.vendor)).toEqual([
			"codex",
			"cursor",
			"mcp-json",
			"agents",
			"octocode",
		]);
	});

	it("loads Claude, Codex and Cursor servers only once their harness is on", () => {
		const { home, cwd, options, toggles, names } = setup();
		writeVendorFiles(home, cwd);
		write(join(cwd, ".mcp.json"), { mcpServers: { root: { command: "r" } } });
		expect(names(loadMcpConfig(options))).toEqual(["root"]);

		toggles(ALL_ON);
		vi.stubEnv("CURSOR_ARG", "arg");
		const loaded = loadMcpConfig(options);
		expect(loaded.errors).toEqual([]);
		expect(names(loaded)).toEqual([
			"claude-http",
			"claude-local",
			"claude-user",
			"codex-http",
			"codex-project",
			"codex-stdio",
			"cursor-project",
			"cursor-user",
			"root",
		]);
		const byName = new Map(loaded.servers.map((entry) => [entry.name, entry]));
		expect(byName.get("claude-user")).toMatchObject({
			vendor: "claude",
			scope: "global",
			config: { command: "node", args: ["a.js"], env: { TOKEN: "${TOKEN}", BANG: "$!literal" } },
		});
		expect(byName.get("claude-http")?.config).toEqual({
			url: "https://example.com/mcp",
			headers: { X: "1" },
			timeout: 2,
		});
		expect(byName.get("codex-stdio")?.config).toEqual({
			command: "node",
			args: ["c.js"],
			cwd: "/tmp",
			env: { PATH_VAR: "${PATH_VAR}", A: "1" },
			timeout: 30,
			exposure: "hidden",
			toolExposure: { read: "direct", list: "hidden" },
		});
		expect(byName.get("codex-http")?.config).toEqual({
			url: "https://codex.example/mcp",
			enabled: false,
			headers: { "X-Team": "core", "X-Key": "${KEY_VAR}", Authorization: "Bearer ${CODEX_TOKEN}" },
		});
		expect(byName.get("codex-project")).toMatchObject({ scope: "project", vendor: "codex" });
		expect(byName.get("cursor-project")).toMatchObject({ scope: "project", vendor: "cursor" });
	});

	it("interpolates Cursor variables, deferring env references in env values to launch", () => {
		const { home, cwd, options, toggles } = setup();
		writeVendorFiles(home, cwd);
		toggles({ "harness:cursor": true });
		vi.stubEnv("CURSOR_ARG", "from-env");
		expect(loadMcpConfig(options).servers.find((entry) => entry.name === "cursor-user")?.config).toEqual({
			command: `${home}/bin/server`,
			args: [cwd, "project", "from-env"],
			env: { KEY: "${CURSOR_SECRET}" },
		});
		vi.stubEnv("CURSOR_ARG", undefined);
		const failed = loadMcpConfig(options);
		expect(failed.servers.some((entry) => entry.name === "cursor-user")).toBe(false);
		expect(failed.errors).toEqual([
			`${join(home, ".cursor", "mcp.json")}: server "cursor-user": \${env:CURSOR_ARG} is not set`,
		]);
	});

	it("lets a project key switch only that vendor's project files", () => {
		const { home, cwd, options, toggles, names } = setup();
		writeVendorFiles(home, cwd);
		toggles(ALL_ON, join(cwd, ".octocode", "settings.json"));
		expect(names(loadMcpConfig(options))).toEqual(["codex-project", "cursor-project"]);
		// Untrusted, the project settings and project files are both out.
		expect(names(loadMcpConfig({ ...options, projectTrusted: false }))).toEqual([]);
		// A project key can also switch a vendor's project files off while its global files stay on.
		toggles(ALL_ON);
		toggles({ "harness:codex": false }, join(cwd, ".octocode", "settings.json"));
		const loaded = names(loadMcpConfig(options));
		expect(loaded).toContain("codex-stdio");
		expect(loaded).not.toContain("codex-project");
	});

	it("never lets another agent's server replace a default or Octocode-format server of the same name", () => {
		const { home, cwd, agentDir, options, toggles } = setup();
		toggles(ALL_ON);
		write(join(home, ".codex", "config.toml"), '[mcp_servers.octocode]\ncommand = "codex-octocode"\n');
		write(join(home, ".octocode", "mcp.json"), { mcpServers: { shared: { command: "own" } } });
		write(join(cwd, ".cursor", "mcp.json"), { mcpServers: { shared: { command: "cursor" } } });
		const defaults = presetEntries([octocodePreset(() => [], {})]);
		const loaded = loadMcpConfig({ ...options, defaults });
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers.find((entry) => entry.name === "octocode")).toMatchObject({ scope: "default" });
		expect(loaded.servers.find((entry) => entry.name === "shared")?.config).toMatchObject({ command: "own" });
		// Listing still names the shadowed entry in its own file.
		const cursor = mcpConfigFiles(agentDir, cwd).find((file) => file.vendor === "cursor" && file.scope === "project")!;
		expect(listMcpFileEntries(cursor, cwd).entries).toEqual([{ name: "shared", override: false }]);
	});

	it("keeps an Octocode override of a switched-off vendor's server quiet, and applies it once the vendor is on", () => {
		const { home, cwd, options, toggles } = setup();
		writeVendorFiles(home, cwd);
		write(join(home, ".octocode", "mcp.json"), { mcpServers: { "claude-user": { enabled: false } } });
		expect(loadMcpConfig(options).errors).toEqual([]);
		toggles({ "harness:claude": true });
		expect(loadMcpConfig(options).servers.find((entry) => entry.name === "claude-user")).toMatchObject({
			source: join(home, ".claude.json"),
			config: { enabled: false },
		});
	});

	it("reports unusable vendor files as config errors", () => {
		const { home, options, toggles } = setup();
		toggles(ALL_ON);
		write(join(home, ".codex", "config.toml"), "[mcp_servers.broken\n");
		write(join(home, ".claude.json"), { mcpServers: { ws: { type: "ws", url: "wss://x" } } });
		expect(loadMcpConfig(options).errors).toEqual([
			`${join(home, ".claude.json")}: server "ws": transport type "ws" is not supported`,
			`${join(home, ".codex", "config.toml")}: Invalid TOML configuration`,
		]);
	});
});

describe("requestMcpReload", () => {
	it("resolves undefined without an MCP owner", async () => {
		const { createEventBus } = await import("@octocodeai/octocode-agent-core");
		expect(await requestMcpReload(createEventBus())).toBeUndefined();
	});

	it("re-reads the config and applies the difference to the running session", async () => {
		const entry = (name: string, command = "never-started"): McpServerEntry => ({
			name,
			config: { command, enabled: false },
			source: "/config/mcp.json",
			scope: "global",
		});
		let servers = [entry("kept"), entry("dropped"), entry("changed")];
		const host = mcpHost({ loadConfig: () => ({ servers: structuredClone(servers), errors: [] }) });
		await host.start();
		servers = [entry("kept"), entry("changed", "new-command"), entry("new")];
		const result = await requestMcpReload(host.api.events);
		expect(result).toEqual({ added: ["changed", "new"], removed: ["dropped", "changed"] });
		expect(host.state.servers.map((server) => server.entry.name).sort()).toEqual(["changed", "kept", "new"]);
		expect(host.state.findServer("changed")?.entry.config).toMatchObject({ command: "new-command" });
		expect(await requestMcpReload(host.api.events)).toEqual({ added: [], removed: [] });
		await host.close();
		expect(await requestMcpReload(host.api.events)).toBeUndefined();
	});
});
