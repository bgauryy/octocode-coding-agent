import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../coding-agent/src/config.ts";
import { effectivePlugins } from "../../coding-agent/src/core/extensibility/toggles.ts";
import { loadConfiguredPluginMcp } from "../../coding-agent/src/core/plugin-mcp.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { grantFolder } from "../../coding-agent/src/octocode/trust/grants.ts";
import { runMcpCommand } from "../src/cli.ts";

describe("plugin MCP servers and folder trust", () => {
	const dirs: string[] = [];
	const temp = (prefix: string) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		vi.unstubAllEnvs();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	/** A folder whose project settings enable a plugin (inside the folder) that declares one server. */
	function projectWithPlugin() {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-plugin-trust-home-"));
		const agentDir = temp("octocode-plugin-trust-agent-");
		const cwd = temp("octocode-plugin-trust-project-");
		const plugin = join(cwd, "kit");
		mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
		writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "kit" }));
		writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { command: "never-started" } } }));
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ plugins: [{ path: plugin, protocol: "claude" }] }),
		);
		return { agentDir, cwd };
	}

	const sessionServers = (cwd: string, agentDir: string, projectTrusted: boolean) => {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted }).getSettings();
		return loadConfiguredPluginMcp(effectivePlugins(settings, cwd), cwd).servers.map((server) => server.name);
	};

	it("registers no project plugin server for a session in an untrusted folder", () => {
		const { agentDir, cwd } = projectWithPlugin();
		expect(sessionServers(cwd, agentDir, false)).toEqual([]);
		expect(sessionServers(cwd, agentDir, true)).toEqual(["plugin:kit:probe"]);
	});

	it("lists no project plugin server for `octocode mcp list` until the folder is trusted", async () => {
		const { agentDir, cwd } = projectWithPlugin();
		const list = async () => {
			const output: string[] = [];
			await runMcpCommand(["list", "--json"], {
				presets: [],
				cwd,
				agentDir,
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			});
			return output.join("\n");
		};
		expect(await list()).not.toContain("plugin:kit:probe");
		grantFolder(cwd, "folder", { source: "command", surface: "test" });
		expect(await list()).toContain("plugin:kit:probe");
	});
});
