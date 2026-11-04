import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The directory of a dependency as the installed package resolves it at run time. A release's `exports` may hide its package.json, so look through the lookup paths. */
function installedPackageDir(packageDir, name) {
	const paths = createRequire(join(packageDir, "package.json")).resolve.paths(name) ?? [];
	const found = paths.map((path) => join(path, name)).find((path) => existsSync(join(path, "package.json")));
	if (!found) throw new Error(`Installed Octocode is missing ${name}`);
	return found;
}

export const codingAgentName = "@octocodeai/octocodecode";

export function smokeTestCodingAgent(directory, runtime = process.execPath, { strictRuntime = false } = {}) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const name of ["mcp", "acp", "common", "db"]) {
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
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		const profileDir = join(packageDir, "dist/octocode/instructions/roles");
		if (!existsSync(profileDir) || !readdirSync(profileDir).some((name) => name.endsWith(".md"))) {
			throw new Error("Installed Octocode package is missing bundled subagent profiles");
		}
		// The policy prompt is Markdown read at runtime (`getInstructionsDir`); without it every session fails to build its prompt.
		if (!existsSync(join(packageDir, "dist/octocode/instructions/policy/work.md"))) {
			throw new Error("Installed Octocode package is missing the bundled prompt instructions");
		}
		for (const skill of ["octocode-context-optimization", "octocode-debugging"]) {
			if (!existsSync(join(packageDir, `dist/octocode/native-skills/${skill}/SKILL.md`))) {
				throw new Error(`Installed Octocode package is missing the bundled ${skill} skill`);
			}
		}
		if (existsSync(join(packageDir, "src"))) throw new Error("Installed Octocode must not depend on source files");
		// The research server runs from its installed package (the MCP preset's launch), never through npx.
		const mcpDir = installedPackageDir(packageDir, "octocode-mcp");
		const mcpManifest = JSON.parse(readFileSync(join(mcpDir, "package.json"), "utf8"));
		const mcpBin = typeof mcpManifest.bin === "string" ? mcpManifest.bin : mcpManifest.bin?.["octocode-mcp"];
		if (!mcpBin || !existsSync(join(mcpDir, mcpBin)))
			throw new Error("Installed Octocode is missing its MCP executable");
		if (strictRuntime) {
			// The research skills the agent lists by default come from the installed octocode package (`getBundledSkillsDir`).
			const skillsDir = join(installedPackageDir(packageDir, "octocode"), "skills");
			if (
				!existsSync(skillsDir) ||
				!readdirSync(skillsDir).some((name) => existsSync(join(skillsDir, name, "SKILL.md")))
			)
				throw new Error("Installed Octocode is missing the bundled research skills");
		}
		// Every public entry, imported as a consumer does: a runtime dependency the bundle left out fails here. The build
		// rejects any other unresolved import, so the bundled internals need no separate import check.
		writeFileSync(
			entry,
			`import assert from "node:assert/strict";
import { RpcClient, runRpcMode, runPrintMode, main } from "${codingAgentName}";
import { McpClient, StdioTransport } from "${codingAgentName}/mcp";
import { McpOAuthProvider } from "${codingAgentName}/mcp/oauth";
for (const entry of [RpcClient, runRpcMode, runPrintMode, main]) assert.equal(typeof entry, "function");
for (const entry of [McpClient, StdioTransport, McpOAuthProvider]) assert.equal(typeof entry, "function");
`,
		);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		const version = execFileSync(runtime, [join(packageDir, manifest.bin.octocode), "--version"], {
			cwd: directory,
			encoding: "utf8",
			env,
			stdio: ["inherit", "pipe", "pipe"],
			timeout: 30_000,
		});
		if (version.trim() !== manifest.version) throw new Error(`Unexpected version from the installed CLI: ${version}`);
		const apiHelp = execFileSync(runtime, [join(packageDir, manifest.bin["octocode-api"])], {
			cwd: directory,
			encoding: "utf8",
			env,
			stdio: ["inherit", "pipe", "pipe"],
			timeout: 30_000,
		});
		if (!apiHelp.includes("octocode-api list")) throw new Error("Installed Octocode API CLI did not show usage");
		if (strictRuntime) {
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
