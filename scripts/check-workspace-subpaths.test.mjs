import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findMissingSubpaths } from "./check-workspace-subpaths.mjs";

function fixture(source, exportsMap) {
	const root = mkdtempSync(join(tmpdir(), "subpaths-"));
	const lib = join(root, "packages", "lib");
	const app = join(root, "packages", "app");
	mkdirSync(join(lib, "src"), { recursive: true });
	mkdirSync(join(app, "src"), { recursive: true });
	writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "@octocodeai/lib", exports: exportsMap }));
	writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@octocodeai/app" }));
	writeFileSync(join(app, "src", "index.ts"), source);
	return root;
}

test("reports an imported subpath that exports does not list", () => {
	const root = fixture('import { a } from "@octocodeai/lib/missing";\n', {
		".": "./index.js",
		"./other": "./other.js",
	});
	try {
		const problems = findMissingSubpaths(root);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /@octocodeai\/lib\/missing is not in exports/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("accepts listed subpaths, wildcard exports, and non-import strings", () => {
	const source = [
		'import { a } from "@octocodeai/lib/other";',
		'const b = await import("@octocodeai/lib/deep/thing");',
		'export const key = Symbol.for("@octocodeai/lib/not-an-import");',
	].join("\n");
	const root = fixture(source, { "./other": "./other.js", "./deep/*": "./deep/*.js" });
	try {
		assert.deepEqual(findMissingSubpaths(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
