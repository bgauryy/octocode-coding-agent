import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageHostSources } from "./build-host-sources.mjs";
import { readWorkspacePackages, sourceWorkspaceGroups } from "./source-workspaces.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("ACP has one source owner and ships inside coding-agent without a private runtime dependency", () => {
	const packages = readWorkspacePackages(root);
	assert.ok(packages.acp, "ACP must have its own workspace");
	assert.equal(packages.acp.private, true);
	assert.deepEqual(packages.acp.octocodeSource, { host: "coding-agent", mount: "acp" });
	assert.equal(packages["coding-agent"].devDependencies[packages.acp.name], "workspace:*");
	assert.equal(packages["coding-agent"].dependencies[packages.acp.name], undefined);
	assert.equal(
		packages.acp.dependencies["@agentclientprotocol/sdk"],
		packages["coding-agent"].dependencies["@agentclientprotocol/sdk"],
	);
	assert.deepEqual(sourceWorkspaceGroups(packages).issues, []);
	assert.equal(existsSync(join(root, "packages/coding-agent/src/modes/acp")), false);
	assert.equal(existsSync(join(root, "packages/coding-agent/src/octocode/external/acp.ts")), false);
});

test("host staging relocates inbound ACP, outbound ACP and MCP handoff to the shipped tree", (t) => {
	const stage = mkdtempSync(join(tmpdir(), "octocode-acp-stage-"));
	t.after(() => rmSync(stage, { recursive: true, force: true }));
	stageHostSources(root, "coding-agent", stage);
	const read = (file) => readFileSync(join(stage, "src", file), "utf8");
	assert.match(read("main.ts"), /import\("\.\/acp\/server\/acp-mode\.ts"\)/);
	assert.match(read("octocode/external/manager.ts"), /from "\.\.\/\.\.\/acp\/client\/client\.ts"/);
	assert.match(read("acp/server/mcp.ts"), /from "\.\.\/\.\.\/mcp\/config\.ts"/);
	assert.match(read("acp/server/acp-mode.ts"), /from "\.\.\/\.\.\/modes\/rpc\/rpc-client\.ts"/);
	assert.match(read("acp/client/client.ts"), /from "\.\.\/\.\.\/octocode\/shared\/process\.ts"/);
});
