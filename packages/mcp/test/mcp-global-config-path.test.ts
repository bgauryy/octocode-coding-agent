import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../coding-agent/src/config.ts";
import { loadMcpConfig } from "../src/config.ts";
import { runMcpCommand } from "../src/cli.ts";
import { globalMcpConfigPath, globalMcpConfigPaths } from "../src/paths.ts";
import { getMcpConfigLocations } from "../src/inspection.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedHome() {
	const home = mkdtempSync(join(tmpdir(), "octocode-mcp-global-path-"));
	roots.push(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	const write = (file: string, servers: Record<string, unknown>) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ mcpServers: servers }));
	};
	return { home, write, agentDir: getAgentDir() };
}

describe("the global mcp.json", () => {
	it("is written to ~/.octocode/mcp.json for the default home, whatever other agents left on disk", async () => {
		const { home, write, agentDir } = isolatedHome();
		const canonical = join(home, ".octocode", "mcp.json");
		// Files of other layouts and agents are read as fallbacks, but `mcp add` never writes them.
		const others = [
			join(home, ".pi", "mcp.json"),
			join(home, ".pi", "agent", "mcp.json"),
			join(home, ".octocode", "agent", "mcp.json"),
			join(agentDir, "mcp.json"),
		];
		for (const file of others) write(file, { [`from-${others.indexOf(file)}`]: { command: "other" } });
		const before = others.map((file) => readFileSync(file, "utf8"));

		expect(globalMcpConfigPath(agentDir)).toBe(canonical);
		expect(globalMcpConfigPaths(agentDir)).toContain(canonical);
		expect(getMcpConfigLocations(agentDir, join(home, "project"), true)).toMatchObject({ globalWrite: canonical });
		expect(loadMcpConfig({ agentDir, cwd: join(home, "project"), projectTrusted: false }).globalConfig).toBe(canonical);

		const output: string[] = [];
		const exitCode = await runMcpCommand(["add", "files", "--", "node", "server.js"], {
			cwd: join(home, "project"),
			agentDir,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		expect({ exitCode, output: output.join("\n") }).toMatchObject({ exitCode: 0 });
		expect(JSON.parse(readFileSync(canonical, "utf8"))).toMatchObject({
			mcpServers: { files: { command: "node", args: ["server.js"] } },
		});
		expect(others.filter((file) => file !== canonical).map((file) => readFileSync(file, "utf8"))).toEqual(
			before.filter((_, index) => others[index] !== canonical),
		);
	});

	it.each(["OCTOCODE_HOME", "OCTOCODE_CODING_AGENT_DIR"])("is inside the directory %s names", (name) => {
		const { home, write } = isolatedHome();
		const chosen = join(home, "chosen");
		vi.stubEnv(name, chosen);
		write(join(home, ".octocode", "mcp.json"), { shared: { command: "shared" } });
		write(join(home, ".pi", "mcp.json"), { pi: { command: "pi" } });
		write(join(chosen, "mcp.json"), { own: { command: "own" } });
		const agentDir = getAgentDir();
		expect(globalMcpConfigPath(agentDir)).toBe(join(chosen, "mcp.json"));
		expect(globalMcpConfigPaths(agentDir)).toEqual([join(chosen, "mcp.json")]);
		expect(loadMcpConfig({ agentDir, cwd: home, projectTrusted: false }).servers.map((entry) => entry.name)).toEqual([
			"own",
		]);
	});

	it("is inside an explicit agent directory", () => {
		const { home } = isolatedHome();
		const sdk = join(home, "sdk");
		expect(globalMcpConfigPath(sdk)).toBe(join(sdk, "mcp.json"));
		expect(globalMcpConfigPaths(sdk)).toEqual([join(sdk, "mcp.json")]);
		expect(existsSync(sdk)).toBe(false);
	});
});
