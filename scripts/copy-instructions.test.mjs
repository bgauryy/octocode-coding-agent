import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyInstructions } from "./copy-instructions.mjs";

test("copies the prompt Markdown folders, not TypeScript, the README or the generated final prompts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "copy-instructions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "src");
	for (const folder of ["policy", "roles", "final"]) mkdirSync(join(source, folder), { recursive: true });
	writeFileSync(join(source, "final", "main.md"), "generated\n");
	writeFileSync(join(source, "policy", "work.md"), "work\n");
	writeFileSync(join(source, "roles", "lean.md"), "lean\n");
	writeFileSync(join(source, "README.md"), "map\n");
	writeFileSync(join(source, "policy.ts"), "export {};\n");
	const destination = join(root, "dist");
	mkdirSync(join(destination, "policy"), { recursive: true });
	writeFileSync(join(destination, "policy", "stale.md"), "deleted upstream\n");
	copyInstructions(source, destination);
	assert.ok(existsSync(join(destination, "policy", "work.md")));
	assert.ok(existsSync(join(destination, "roles", "lean.md")));
	assert.equal(existsSync(join(destination, "policy", "stale.md")), false);
	assert.equal(existsSync(join(destination, "README.md")), false);
	assert.equal(existsSync(join(destination, "policy.ts")), false);
	assert.equal(existsSync(join(destination, "final")), false);
});
