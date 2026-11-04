import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(repoRoot, file), "utf8");
const siblingRef = read(".github/octocode-ref").trim();
const ci = read(".github/workflows/ci.yml");

test("the sibling ref file holds one ref, and the README names it", () => {
	assert.match(siblingRef, /^[\w./-]+$/);
	assert.ok(read("README.md").includes(`\`${siblingRef}\``), "README.md does not name the sibling ref");
	assert.ok(read("README.md").includes(".github/octocode-ref"));
});

test("CI builds the sibling from the committed ref, not the sibling's default branch", () => {
	assert.ok(ci.includes("cat octocodecode/.github/octocode-ref"));
	assert.ok(ci.includes("ref: ${{ steps.sibling.outputs.ref }}"));
	assert.doesNotMatch(ci, /\|\|\s*'main'/);
	// A dispatch default would win over the file.
	assert.doesNotMatch(ci, /octocode-ref:\n\s+description:[^\n]*\n\s+default:/);
});

test("Node comes from one committed version, within what the sibling's native package accepts", () => {
	assert.equal(read(".node-version").trim(), "24");
	assert.ok(ci.includes("node-version-file: octocodecode/.node-version"));
	assert.match(JSON.parse(read("package.json")).engines.node, /^>=24\.15\.0/);
});
