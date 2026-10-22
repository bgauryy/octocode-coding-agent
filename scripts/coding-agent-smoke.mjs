import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const codingAgentName = "@octocodeai/octocodecode";

export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const home = mkdtempSync(join(tmpdir(), "octocode-coding-agent-smoke-home-"));
	const entry = join(packageDir, "octocode-install-smoke.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		OCTOCODE_CODING_AGENT_DIR: join(home, ".octocode", "agent"),
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_TELEMETRY: "0",
		OCTOCODE_MCP: "0",
		OCTOCODE_API: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		const profileDir = join(packageDir, "dist/octocode/instructions/roles");
		if (!existsSync(profileDir) || !readdirSync(profileDir).some((name) => name.endsWith(".md"))) {
			throw new Error("Installed Octocode package is missing bundled subagent profiles");
		}
		if (existsSync(join(packageDir, "src"))) throw new Error("Installed Octocode must not depend on source files");
		writeFileSync(entry, `import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
import octocode from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/octocode/index.js")).href)};
import { octocodeLaunch } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/octocode/mcp/octocode.js")).href)};
import { getCliInvocation, getSubagentsDir } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/config.js")).href)};
for (const dependency of ["octocode-mcp", "chrome-launcher", "@agentclientprotocol/sdk"]) {
	assert.ok(existsSync(fileURLToPath(import.meta.resolve(dependency))), dependency);
}
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
assert.equal(typeof octocode, "function");
const mcpLaunch = octocodeLaunch(process.cwd());
assert.equal(mcpLaunch.command, process.execPath, "installed MCP runs without npx");
assert.ok(existsSync(mcpLaunch.args[0]), "MCP executable exists");
assert.equal(realpathSync(getSubagentsDir()), realpathSync(${JSON.stringify(profileDir)}));
assert.ok(getCliInvocation().prefix.some((argument) => argument.endsWith("dist/bundle/cli.js")));
`);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		for (const cli of new Set([manifest.bin.octocode, "dist/cli.js"])) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
		const apiHelp = execFileSync(runtime, [join(packageDir, manifest.bin["octocode-api"])], {
			cwd: directory,
			encoding: "utf8",
			env,
			stdio: ["inherit", "pipe", "pipe"],
			timeout: 30_000,
		});
		if (!apiHelp.includes("octocode-api list")) throw new Error("Installed Octocode API CLI did not show usage");
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
