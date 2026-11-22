import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
}

function createFixture(t, { importUndeclared = false } = {}) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "octocode-agent-smoke-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	for (const name of ["octocode-mcp", "@agentclientprotocol/sdk"]) {
		writePackage(
			join(repoRoot, "packages", name.replaceAll("/", "-")),
			{
				name,
				version: "1.0.0",
				type: "module",
				...(name === "octocode-mcp"
					? { bin: "dist/cli.js" }
					: {
							main: "./dist/index.js",
							types: "./dist/index.d.ts",
							exports: { ".": { import: "./dist/index.js" } },
						}),
				files: ["dist"],
			},
			{
				"dist/index.js": "export {};\n",
				"dist/index.d.ts": "export {};\n",
				"dist/cli.js": "console.log('MCP fixture');\n",
			},
		);
	}
	const agentPackage = join(repoRoot, "packages", codingAgentName.split("/")[1]);
	writePackage(
		agentPackage,
		{
			name: codingAgentName,
			version: "1.0.0",
			type: "module",
			main: "./dist/bundle/index.js",
			exports: {
				".": { import: "./dist/bundle/index.js" },
				"./mcp": "./dist/bundle/mcp.js",
				"./mcp/oauth": "./dist/bundle/mcp-oauth.js",
			},
			files: ["dist"],
			bin: { octocode: "dist/bundle/cli.js", "octocode-api": "dist/bundle/octocode-api.js" },
			dependencies: { "octocode-mcp": "1.0.0", "@agentclientprotocol/sdk": "1.0.0" },
		},
		{
			"dist/bundle/index.js": `${importUndeclared ? 'import "@octocodeai/undeclared";' : ""}
export class RpcClient {}
export function runRpcMode() {}
export function runPrintMode() {}
export function main() {}
`,
			"dist/bundle/mcp.js": "export class McpClient {}\nexport class StdioTransport {}\n",
			"dist/bundle/mcp-oauth.js": "export class McpOAuthProvider {}\n",
			"dist/bundle/cli.js": 'console.log("1.0.0");\n',
			"dist/bundle/octocode-api.js": 'console.log("octocode-api list");\n',
			"dist/octocode/native/skills/octocode-context-optimization/SKILL.md":
				"---\nname: octocode-context-optimization\ndescription: Test\n---\n",
			"dist/octocode/native/skills/octocode-debugging/SKILL.md":
				"---\nname: octocode-debugging\ndescription: Test\n---\n",
			"dist/octocode/native/skills/resume-external-harness/SKILL.md":
				"---\nname: resume-external-harness\ndescription: Test\n---\n",
			"dist/octocode/native/agents/researcher.md": "---\nname: researcher\n---\nResearch the requested code.\n",
		},
	);
	cpSync(
		new URL("../packages/coding-agent/src/octocode/native/prompts/policy/", import.meta.url),
		join(agentPackage, "dist/octocode/native/prompts/policy"),
		{ recursive: true },
	);
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null });
	const directory = join(root, "consumer");
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	return directory;
}

test("accepts a valid coding-agent package with a CLI-only MCP dependency", (t) => {
	smokeTestCodingAgent(createFixture(t));
});

test("rejects a missing MCP executable", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", "octocode-mcp", "dist/cli.js"));
	assert.throws(() => smokeTestCodingAgent(directory), /missing its MCP executable/);
});

// #9132: smoke-test the package root (CLI and RPC exports), not just a bundled CLI that hides missing imports.
test("fails when the package root imports an undeclared package despite a working CLI", (t) => {
	const directory = createFixture(t, { importUndeclared: true });
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find package '@octocodeai\/undeclared'/);
});

test("rejects a package missing its bundled subagent profiles", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/octocode/native/agents"), { recursive: true });
	assert.throws(() => smokeTestCodingAgent(directory), /missing bundled subagent profiles/);
});

test("rejects a package missing the bundled prompt instructions", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/octocode/native/prompts/policy/finish.md"));
	assert.throws(() => smokeTestCodingAgent(directory), /missing the bundled prompt instructions in finish\.md/);
});

test("rejects a package missing the bundled octocode-context-optimization skill", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/octocode/native/skills"), { recursive: true });
	assert.throws(() => smokeTestCodingAgent(directory), /missing the bundled octocode-context-optimization skill/);
});

test("rejects a broken API executable despite a working agent CLI", (t) => {
	const directory = createFixture(t);
	writeFileSync(join(directory, "node_modules", codingAgentName, "dist/bundle/octocode-api.js"), "process.exit(2);\n");
	assert.throws(() => smokeTestCodingAgent(directory), /Command failed/);
});

test("rejects a missing public MCP export despite a working package root", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/bundle/mcp.js"));
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find module/);
});

test("rejects an installed CLI that reports another version", (t) => {
	const directory = createFixture(t);
	writeFileSync(join(directory, "node_modules", codingAgentName, "dist/bundle/cli.js"), 'console.log("0.0.1");\n');
	assert.throws(() => smokeTestCodingAgent(directory), /Unexpected version from the installed CLI/);
});
