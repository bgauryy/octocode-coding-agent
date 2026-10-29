import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const codingAgentName = "@octocodeai/octocodecode";

export function smokeTestCodingAgent(directory, runtime = process.execPath, { strictRuntime = false } = {}) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const name of ["mcp", "acp"]) {
		const dependency = `@octocodeai/octocode-${name}`;
		if (manifest.dependencies?.[dependency] || manifest.optionalDependencies?.[dependency])
			throw new Error(`Installed Octocode must not depend on the private ${name.toUpperCase()} workspace`);
	}
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
		if (!existsSync(join(packageDir, "dist/octocode/native-skills/octocode-compact-mcp/SKILL.md"))) {
			throw new Error("Installed Octocode package is missing the bundled octocode-compact-mcp skill");
		}
		if (existsSync(join(packageDir, "src"))) throw new Error("Installed Octocode must not depend on source files");
		writeFileSync(
			entry,
			`import assert from "node:assert/strict";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
import { McpClient, StdioTransport } from "${codingAgentName}/mcp";
import { McpOAuthProvider } from "${codingAgentName}/mcp/oauth";
import { createInMemoryTransportPair } from "${codingAgentName}/mcp/testing";
import octocode from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/octocode/index.js")).href)};
import { octocodeLaunch } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/mcp/presets/octocode/launch.js")).href)};
import { runAcpMode } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/acp/server/acp-mode.js")).href)};
import { AcpBackend } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/acp/client/client.js")).href)};
import { getCliInvocation, getSubagentsDir${strictRuntime ? ", getBundledSkillsDir, getResearchCliInvocation" : ""} } from ${JSON.stringify(pathToFileURL(join(packageDir, "dist/config.js")).href)};
for (const dependency of ["chrome-launcher", "@agentclientprotocol/sdk"]) {
	assert.ok(existsSync(fileURLToPath(import.meta.resolve(dependency))), dependency);
}
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
assert.equal(typeof octocode, "function");
assert.equal(typeof runAcpMode, "function");
assert.equal(typeof AcpBackend.connect, "function");
for (const entry of [McpClient, StdioTransport, McpOAuthProvider, createInMemoryTransportPair]) assert.equal(typeof entry, "function");
const mcpLaunch = octocodeLaunch(process.cwd());
assert.equal(mcpLaunch.command, process.execPath, "installed MCP runs without npx");
assert.ok(existsSync(mcpLaunch.args[0]), "MCP executable exists");
assert.equal(realpathSync(getSubagentsDir()), realpathSync(${JSON.stringify(profileDir)}));
assert.ok(getCliInvocation().prefix.some((argument) => argument.endsWith("dist/bundle/cli.js")));
${
	strictRuntime
		? `assert.ok(existsSync(getBundledSkillsDir()), "research skills are packaged");
assert.ok(
	readdirSync(getBundledSkillsDir()).some((name) => existsSync(join(getBundledSkillsDir(), name, "SKILL.md"))),
	"the bundled skills the agent lists by default are packaged",
);
for (const kind of ["research", "native"]) {
	const invocation = getResearchCliInvocation(kind);
	assert.ok(existsSync(invocation.prefix[0] ?? invocation.command), kind + " entry is packaged");
}
`
		: ""
}
`,
		);
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
		if (strictRuntime) {
			const modelsDir = join(directory, "node_modules", "@octocodeai", "octocode-ai", "dist", "providers", "data");
			if (!existsSync(modelsDir) || !readdirSync(modelsDir).some((name) => name.endsWith(".json"))) {
				throw new Error("Installed Octocode AI package is missing hydrated model data");
			}
			for (const kind of ["research", "native"]) {
				const manifestName = kind === "research" ? "octocode" : "@octocodeai/octocode-native";
				const siblingDir = join(directory, "node_modules", manifestName);
				const sibling = JSON.parse(readFileSync(join(siblingDir, "package.json"), "utf8"));
				const bin = typeof sibling.bin === "string" ? sibling.bin : sibling.bin?.octocode;
				if (!bin || !existsSync(join(siblingDir, bin))) throw new Error(`Installed ${kind} executable is missing`);
				execFileSync(runtime, [join(siblingDir, bin), "--help"], {
					cwd: directory,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30_000,
				});
			}
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
