import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { buildSkillVocabulary, findSkillWords } from "../src/octocode/ui/skill-words.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function load(metadata: string) {
	const root = mkdtempSync(join(tmpdir(), "skill-triggers-"));
	roots.push(root);
	mkdirSync(join(root, "pdf-tools"));
	writeFileSync(
		join(root, "pdf-tools/SKILL.md"),
		`---\nname: pdf-tools\ndescription: Test skill\n${metadata}---\nBody`,
	);
	return loadSkillsFromDir({ dir: root, source: "test" });
}

it("carries metadata.triggers into the skill and highlights the trigger word", () => {
	const { skills, diagnostics } = load("metadata:\n  triggers: [invoice, ' receipt ']\n");
	expect(diagnostics).toEqual([]);
	expect(skills[0].triggers).toEqual(["invoice", "receipt"]);
	const vocabulary = buildSkillVocabulary(skills.map(({ name, triggers }) => ({ name, triggers })));
	expect(findSkillWords("scan an invoice", vocabulary)).toEqual([{ start: 8, end: 15, skills: ["pdf-tools"] }]);
});

it("ignores malformed triggers with a diagnostic and still loads the skill", () => {
	for (const bad of ["triggers: invoice", "triggers: [1, 2]", "triggers: {a: b}"]) {
		const { skills, diagnostics } = load(`metadata:\n  ${bad}\n`);
		expect(skills).toHaveLength(1);
		expect(skills[0].triggers).toBeUndefined();
		expect(diagnostics.some((d) => d.message.includes("metadata.triggers"))).toBe(true);
	}
});
