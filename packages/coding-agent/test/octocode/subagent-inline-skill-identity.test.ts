import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { taskSkillText } from "../../src/octocode/subagents/task-skills.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "octocode-inline-skill-")));
	roots.push(root);
	for (const name of ["original", "replacement"]) {
		fs.mkdirSync(path.join(root, name));
		fs.writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: fixture\ndescription: Fixture\n---\nBODY_${name}`);
	}
	const alias = path.join(root, "alias");
	fs.symlinkSync(path.join(root, "original"), alias, "dir");
	const snapshot = captureSkillResourceSnapshot(loadSkillsFromDir({ dir: alias, source: "test" }));
	return { root, alias, snapshot };
}

it("inlines the captured canonical file and reference root after a discovery link changes", () => {
	const { root, alias, snapshot } = fixture();
	fs.unlinkSync(alias);
	fs.symlinkSync(path.join(root, "replacement"), alias, "dir");
	const text = taskSkillText(snapshot, true);
	expect(text).toContain("BODY_original");
	expect(text).not.toContain("BODY_replacement");
	expect(text).toContain(`location="${path.join(root, "original", "SKILL.md")}"`);
	expect(text).toContain(`References are relative to ${path.join(root, "original")}.`);
});

it("refuses a captured canonical file replaced by a link", () => {
	const { root, snapshot } = fixture();
	const original = path.join(root, "original", "SKILL.md");
	fs.unlinkSync(original);
	fs.symlinkSync(path.join(root, "replacement", "SKILL.md"), original);
	expect(() => taskSkillText(snapshot, true)).toThrow("Child skill canonical identity changed");
});
