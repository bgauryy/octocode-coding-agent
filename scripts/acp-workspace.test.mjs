import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
