import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { copyNative, PROMPT_PACK } from "./copy-native.mjs";

function write(root, file, text) {
	const full = join(root, file);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

test("copies prompt Markdown, not TypeScript, READMEs or the generated final prompts; skills ship whole", (t) => {
	const root = mkdtempSync(join(tmpdir(), "copy-native-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "src");
	write(source, "prompts/final/main.md", "generated\n");
	write(source, "prompts/policy/work.md", "work\n");
	write(source, "prompts/policy.ts", "export {};\n");
	write(source, "prompts/README.md", "map\n");
	write(source, "agents/lean.md", "lean\n");
	write(source, "tools/bash/cli.md", "cli\n");
	write(source, "tools/bash/tool.ts", "export {};\n");
	write(source, "hooks/context.md", "context\n");
	write(source, "skills/demo/SKILL.md", "skill\n");
	write(source, "skills/demo/scripts/run.ts", "export {};\n");
	const destination = join(root, "dist");
	write(destination, "prompts/policy/stale.md", "deleted upstream\n");
	copyNative(source, destination);
	for (const file of ["prompts/policy/work.md", "agents/lean.md", "tools/bash/cli.md", "hooks/context.md"])
		assert.ok(existsSync(join(destination, file)), file);
	assert.ok(existsSync(join(destination, "skills/demo/scripts/run.ts")), "skills ship whole");
	for (const file of [
		"prompts/policy/stale.md",
		"prompts/README.md",
		"prompts/policy.ts",
		"prompts/final",
		"tools/bash/tool.ts",
	])
		assert.equal(existsSync(join(destination, file)), false, file);
});

test("packs exactly the shipped prompt Markdown into one file, keyed by path under the folder", (t) => {
	const root = mkdtempSync(join(tmpdir(), "copy-native-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "src");
	write(source, "prompts/final/main.md", "generated\n");
	write(source, "prompts/policy/work.md", "work\n");
	write(source, "prompts/README.md", "map\n");
	write(source, "prompts/policy.ts", "export {};\n");
	write(source, "agents/lean.md", "lean\n");
	write(source, "tools/bash/cli.md", "cli\n");
	write(source, "hooks/context.md", "context\n");
	write(source, "skills/demo/SKILL.md", "skill\n");
	const destination = join(root, "dist");
	copyNative(source, destination);
	assert.deepEqual(JSON.parse(readFileSync(join(destination, PROMPT_PACK), "utf8")), {
		"prompts/policy/work.md": "work\n",
		"agents/lean.md": "lean\n",
		"tools/bash/cli.md": "cli\n",
		"hooks/context.md": "context\n",
	});
});
