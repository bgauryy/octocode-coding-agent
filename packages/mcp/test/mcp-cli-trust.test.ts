import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grantFolder } from "../../coding-agent/src/octocode/trust/grants.ts";
import { runMcpCommand } from "../src/cli.ts";

describe("octocode mcp folder trust", () => {
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

	it("loads project servers only in a folder the user trusted, as a session does", async () => {
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

		const refused = await run(["list", "--json"]);
		expect(refused.output).not.toContain('"name": "project"');
		expect(refused.output).toContain("Project MCP configuration is ignored because the folder is not trusted");

		grantFolder(cwd, "folder", { source: "command", surface: "test" });
		const trusted = await run(["list", "--json"]);
		expect(trusted.output).toContain('"name": "project"');
		expect(trusted.output).not.toContain("not trusted");

		// Trusting a folder trusts its future contents: a later change to the file needs no new decision.
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "changed-command" } } }));
		expect((await run(["list", "--json"])).output).toContain('"name": "project"');
	});
});
