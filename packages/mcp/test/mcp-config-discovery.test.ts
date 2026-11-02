import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../coding-agent/src/config.ts";
import { globalMcpConfigPaths } from "../src/paths.ts";
import { loadMcpConfig, updateMcpServerConfig } from "../src/config.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { presetEntries } from "../src/preset.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
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
	function globalSetup() {
		const { options, write } = setup();
		const home = dirname(options.agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("OCTOCODE_HOME", "");
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
		options.agentDir = getAgentDir();
		return { options, write, home };
	}

	it("layers Pi and previous native defaults before the canonical global MCP configuration", () => {
		const { options, write, home } = globalSetup();
		const paths = [
			join(home, ".pi/mcp.json"),
			join(home, ".pi/agent/mcp.json"),
			join(home, ".octocode/agent/mcp.json"),
			join(options.agentDir, "mcp.json"),
			join(home, ".octocode/mcp.json"),
		];
		expect(globalMcpConfigPaths(options.agentDir)).toEqual(paths);
		for (const [index, file] of paths.entries()) {
			write(file, { shared: { command: `layer-${index}` }, [`unique${index}`]: { command: "unique" } });
			const loaded = loadMcpConfig({ ...options, projectTrusted: false });
			expect(loaded.errors).toEqual([]);
			expect(loaded.servers.find((entry) => entry.name === "shared")).toMatchObject({
				config: { command: `layer-${index}` },
				source: file,
				scope: "global",
			});
			expect(loaded.servers).toHaveLength(index + 2);
			expect(loaded.globalConfig).toBe(paths.at(-1));
		}
	});

	it("keeps omitted enablement and exposure defaults, and applies native and trusted project controls without copying credentials", () => {
		const { options, write, home } = globalSetup();
		const fallback = join(options.agentDir, "mcp.json");
		const canonical = join(home, ".octocode/mcp.json");
		const project = join(options.cwd, ".octocode/mcp.json");
		write(fallback, { octocode: { command: "fallback", env: { TEST_TOKEN: "fixture-only" } } });
		const original = readFileSync(fallback, "utf8");
		const base = loadMcpConfig(options).servers[0];
		expect(base.config.enabled).toBeUndefined();
		expect(base.config.exposure).toBeUndefined();
		updateMcpServerConfig(canonical, "octocode", { enabled: false }, { override: true });
		const disabled = loadMcpConfig(options).servers[0];
		expect(disabled).toMatchObject({
			source: fallback,
			override: canonical,
			overrideScope: "global",
			config: { enabled: false },
		});
		expect(JSON.parse(readFileSync(canonical, "utf8"))).toEqual({ mcpServers: { octocode: { enabled: false } } });
		write(project, { octocode: { enabled: true, exposure: "direct" } });
		expect(loadMcpConfig(options).servers[0]).toMatchObject({
			source: fallback,
			override: project,
			overrideScope: "project",
			config: { command: "fallback", enabled: true, exposure: "direct", env: { TEST_TOKEN: "fixture-only" } },
		});
		expect(loadMcpConfig({ ...options, projectTrusted: false }).servers[0].config.enabled).toBe(false);
		expect(readFileSync(fallback, "utf8")).toBe(original);
	});

	it("deduplicates namespace aliases between layers while rejecting aliases inside one file", () => {
		const { options, write, home } = globalSetup();
		write(join(home, ".pi/mcp.json"), { "work-files": { command: "pi", env: { PRIVATE: "fixture" } } });
		write(join(home, ".octocode/agent/mcp.json"), { work_files: { command: "octocode" } });
		write(join(options.agentDir, "mcp.json"), {
			"work-files": { enabled: false },
			work_files: { command: "conflict" },
		});
		const loaded = loadMcpConfig(options);
		expect(loaded.servers).toHaveLength(1);
		expect(loaded.servers[0]).toMatchObject({ name: "work-files", config: { command: "octocode", enabled: false } });
		expect(loaded.servers[0].config).not.toHaveProperty("env");
		expect(loaded.errors).toEqual([expect.stringContaining('server "work_files" conflicts with "work-files"')]);
	});

	it("retains a valid fallback after an invalid global override and layers codemode activation independently", () => {
		const { options, write, home } = globalSetup();
		const fallback = join(home, ".pi/agent/mcp.json");
		const canonical = join(options.agentDir, "mcp.json");
		write(fallback, { tools: { command: "fallback" } });
		writeFileSync(
			fallback,
			JSON.stringify({ autoEnableCodemode: false, mcpServers: { tools: { command: "fallback" } } }),
		);
		write(canonical, { tools: { enabled: false, env: { EXTRA: "not-allowed-in-controls" } } });
		const failed = loadMcpConfig(options);
		expect(failed.servers[0]).toMatchObject({ source: fallback, config: { command: "fallback" } });
		expect(failed.servers[0].config.enabled).toBeUndefined();
		expect(failed.errors).toEqual([
			expect.stringContaining("an override can only set enabled, defaultActive, exposure, toolExposure"),
		]);
		writeFileSync(canonical, JSON.stringify({ autoEnableCodemode: true, mcpServers: { tools: { enabled: false } } }));
	});

	it.each(["OCTOCODE_HOME", "OCTOCODE_CODING_AGENT_DIR", "sdk"])("keeps %s isolated from every fallback", (kind) => {
		const { options, write, home } = globalSetup();
		write(join(home, ".pi/mcp.json"), { pi: { command: "pi" } });
		write(join(home, ".octocode/mcp.json"), { shared: { command: "shared" } });
		const isolated = join(home, "isolated");
		if (kind !== "sdk") vi.stubEnv(kind, isolated);
		options.agentDir = isolated;
		write(join(isolated, "mcp.json"), { own: { command: "own" } });
		expect(globalMcpConfigPaths(isolated)).toEqual([join(isolated, "mcp.json")]);
		expect(loadMcpConfig(options).servers.map((entry) => entry.name)).toEqual(["own"]);
	});
	it("represents the default opt-out as a disabled server in the same config loader", () => {
		const { options } = setup();
		const defaults = presetEntries([octocodePreset(() => [], { OCTOCODE_MCP: "0" })]);
		expect(loadMcpConfig({ ...options, defaults }).servers).toMatchObject([
			{ name: "octocode", config: { enabled: false } },
		]);
	});
	it("keeps a built-in server's purpose when a configured entry replaces it, unless the entry has its own", () => {
		const { options, write } = setup();
		const defaults = presetEntries([octocodePreset()]);
		const purpose = defaults[0].config.description;
		expect(purpose).toBeTruthy();
		write(join(options.agentDir, "mcp.json"), { octocode: { command: "node", args: ["server.js"] } });
		expect(loadMcpConfig({ ...options, defaults }).servers).toMatchObject([
			{ name: "octocode", scope: "global", config: { command: "node", description: purpose } },
		]);
		// A later project entry for the same server keeps it too.
		write(join(options.cwd, ".mcp.json"), { octocode: { command: "project" } });
		expect(loadMcpConfig({ ...options, defaults }).servers[0].config).toMatchObject({
			command: "project",
			description: purpose,
		});
		write(join(options.agentDir, "mcp.json"), { octocode: { command: "node", description: "My own purpose" } });
		expect(loadMcpConfig({ ...options, defaults, projectTrusted: false }).servers[0].config.description).toBe(
			"My own purpose",
		);
		// A server with no earlier entry gets none.
		write(join(options.agentDir, "mcp.json"), { docs: { command: "docs" } });
		expect(
			loadMcpConfig({ ...options, defaults, projectTrusted: false }).servers.find((entry) => entry.name === "docs")
				?.config.description,
		).toBeUndefined();
	});
	it.each([".pi/mcp.json", ".mcp.json", ".agents/mcp.json", ".octocode/mcp.json"])(
		"loads %s only after trust and shares ownership with the built-in client",
		(relative) => {
			const { options, write } = setup();
			write(join(options.cwd, relative), { octocode: { command: "server", enabled: false } });
			expect(loadMcpConfig({ ...options, projectTrusted: false }).servers).toEqual([]);
			expect(
				loadMcpConfig({ ...options, projectTrusted: false }).servers.find((entry) => entry.name === "octocode"),
			).toBeUndefined();
			const loaded = loadMcpConfig(options);
			expect(loaded.errors).toEqual([]);
			expect(loaded.servers).toHaveLength(1);
			expect(loaded.servers[0].config).toEqual({ command: "server", enabled: false });
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
	it("saves a commented config beside it before rewriting it as plain JSON", () => {
		const { options } = setup();
		const file = join(options.cwd, ".mcp.json");
		const commented = '{ // shared config\n "mcpServers": { "octocode": {"command":"server"} } }';
		writeFileSync(file, commented);
		updateMcpServerConfig(file, "octocode", { enabled: false });
		expect(readFileSync(`${file}.bak`, "utf8")).toBe(commented);
		updateMcpServerConfig(file, "octocode", { enabled: true });
		// The rewritten file has no comments left, so the saved original is not replaced.
		expect(readFileSync(`${file}.bak`, "utf8")).toBe(commented);

		const plain = join(options.cwd, "plain.json");
		writeFileSync(plain, '{ "mcpServers": { "octocode": {"command":"server", "url": "http://x//y"} } }');
		updateMcpServerConfig(plain, "octocode", { enabled: false });
		expect(existsSync(`${plain}.bak`)).toBe(false);
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
