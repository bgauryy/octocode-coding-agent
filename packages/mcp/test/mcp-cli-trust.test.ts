import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "../../coding-agent/src/core/trust-manager.ts";
import { saveDecision } from "../../coding-agent/src/octocode/shared/trust.ts";
import { fingerprint, projectConfigFiles } from "../../coding-agent/src/octocode/shared/trust/files.ts";
import { runMcpCommand } from "../src/cli.ts";

describe("octocode mcp project trust", () => {
	const dirs: string[] = [];
	const temp = (prefix: string) => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		vi.unstubAllEnvs();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	it("loads project servers only when the trusted content still matches, as a session does", async () => {
		vi.stubEnv("OCTOCODE_HOME", temp("octocode-mcp-trust-home-"));
		const agentDir = temp("octocode-mcp-trust-agent-");
		const cwd = temp("octocode-mcp-trust-project-");
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "never-started" } } }));
		const run = async (args: string[]) => {
			const output: string[] = [];
			const exitCode = await runMcpCommand(args, {
				presets: [],
				cwd,
				agentDir,
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			});
			return { exitCode, output: output.join("\n") };
		};

		// The directory is trusted, but nobody reviewed this config with /trust: its command is not started.
		new ProjectTrustStore(agentDir).set(cwd, true);
		const refused = await run(["list", "--json"]);
		expect(refused.output).not.toContain('"name": "project"');
		expect(refused.output).toContain("Project MCP servers are not loaded: their config is new or changed");
		expect((await run(["compact", "list", "--offline"])).output).toContain("Project MCP servers are not loaded");

		saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), true);
		const trusted = await run(["list", "--json"]);
		expect(trusted.output).toContain('"name": "project"');
		expect(trusted.output).not.toContain("not loaded");

		// A change after trust waits for /trust again.
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "changed-command" } } }));
		expect((await run(["list", "--json"])).output).not.toContain('"name": "project"');
	});
});
