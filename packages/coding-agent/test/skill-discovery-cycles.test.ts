import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("cuts cyclic directory links before rediscovering skills and continues other branches", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-skill-cycle-")));
	roots.push(root);
	mkdirSync(join(root, "catalog"));
	mkdirSync(join(root, "catalog", "actual"));
	writeFileSync(join(root, "catalog", "actual", "SKILL.md"), "---\nname: actual\ndescription: Fixture\n---\nBody");
	symlinkSync(root, join(root, "catalog", "cycle"), "dir");

	const result = loadSkillsFromDir({ dir: root, source: "test" });
	expect(result.skills.map((skill) => skill.name)).toEqual(["actual"]);
	expect(result.diagnostics).toEqual([
		{ type: "warning", path: join(root, "catalog", "cycle"), message: "Skipped cyclic skill directory link" },
	]);
});

it("preserves independent discovery aliases for collision precedence", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-skill-alias-")));
	roots.push(root);
	mkdirSync(join(root, "actual"));
	writeFileSync(join(root, "actual", "SKILL.md"), "---\nname: actual\ndescription: Fixture\n---\nBody");
	symlinkSync(join(root, "actual"), join(root, "alias"), "dir");

	const result = loadSkillsFromDir({ dir: root, source: "test" });
	expect(result.skills.map((skill) => skill.filePath).sort()).toEqual([
		join(root, "actual", "SKILL.md"),
		join(root, "alias", "SKILL.md"),
	]);
	expect(result.diagnostics).toEqual([]);
});
