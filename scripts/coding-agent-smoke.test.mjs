import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	const temporaryRoot = mkdtempSync(join(tmpdir(), "octocodecode-smoke-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	for (const name of ["octocode-mcp", "chrome-launcher", "@agentclientprotocol/sdk"]) {
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
	writePackage(
		join(repoRoot, "packages", codingAgentName.split("/")[1]),
		{
			name: codingAgentName,
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./mcp": "./dist/mcp/client/index.js",
				"./mcp/oauth": "./dist/mcp/client/oauth/index.js",
				"./mcp/testing": "./dist/mcp/client/testing/index.js",
			},
			files: ["dist"],
			bin: { octocode: "dist/bundle/cli.js", "octocode-api": "dist/bundle/octocode-api.js" },
			dependencies: { "octocode-mcp": "1.0.0", "chrome-launcher": "1.0.0", "@agentclientprotocol/sdk": "1.0.0" },
		},
		{
			"dist/index.js": `${importUndeclared ? 'import "@octocodeai/undeclared";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`,
			"dist/index.d.ts": "export {};\n",
			"dist/acp/server/acp-mode.js": "export function runAcpMode() {}\n",
			"dist/acp/client/client.js": "export class AcpBackend { static connect() {} }\n",
			"dist/mcp/client/index.js": "export class McpClient {}\nexport class StdioTransport {}\n",
			"dist/mcp/client/oauth/index.js": "export class McpOAuthProvider {}\n",
			"dist/mcp/client/testing/index.js": "export function createInMemoryTransportPair() {}\n",
			"dist/cli.js": 'console.log("1.0.0");\n',
			"dist/bundle/cli.js": 'console.log("1.0.0");\n',
			"dist/bundle/octocode-api.js": 'console.log("octocode-api list");\n',
			"dist/octocode/index.js": "export default function octocode() {};\n",
			"dist/mcp/presets/octocode/launch.js": `import { fileURLToPath } from "node:url";
export function octocodeLaunch() {
	return { command: process.execPath, args: [fileURLToPath(new URL("./dist/cli.js", import.meta.resolve("octocode-mcp/package.json")))] };
}
`,
			"dist/config.js": `import { fileURLToPath } from "node:url";
export function getSubagentsDir() { return fileURLToPath(new URL("./octocode/instructions/roles", import.meta.url)); }
export function getCliInvocation() {
	return { command: process.execPath, prefix: [fileURLToPath(new URL("./bundle/cli.js", import.meta.url))] };
}
`,
			"dist/octocode/native-skills/octocode-compact-mcp/SKILL.md":
				"---\nname: octocode-compact-mcp\ndescription: Test\n---\n",
			"dist/octocode/instructions/roles/researcher.md": "---\nname: researcher\n---\nResearch the requested code.\n",
		},
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
	assert.throws(() => smokeTestCodingAgent(directory), /MCP executable exists/);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared package despite a working CLI", (t) => {
	const directory = createFixture(t, { importUndeclared: true });
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find package '@octocodeai\/undeclared'/);
});

test("rejects a package missing its bundled subagent profiles", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/octocode/instructions/roles"), { recursive: true });
	assert.throws(() => smokeTestCodingAgent(directory), /missing bundled subagent profiles/);
});

test("rejects a package missing the bundled octocode-compact-mcp skill", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/octocode/native-skills"), { recursive: true });
	assert.throws(() => smokeTestCodingAgent(directory), /missing the bundled octocode-compact-mcp skill/);
});

test("rejects a broken API executable despite a working agent CLI", (t) => {
	const directory = createFixture(t);
	writeFileSync(join(directory, "node_modules", codingAgentName, "dist/bundle/octocode-api.js"), "process.exit(2);\n");
	assert.throws(() => smokeTestCodingAgent(directory), /Command failed/);
});

test("rejects a missing public MCP export despite a working agent SDK", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/mcp/client/index.js"));
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find module/);
});

test("rejects a missing ACP backend despite a working bundled CLI", (t) => {
	const directory = createFixture(t);
	rmSync(join(directory, "node_modules", codingAgentName, "dist/acp/client/client.js"));
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find module/);
});
