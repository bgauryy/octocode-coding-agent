import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extractSkillMentions, selectExplicitSkills } from "../src/core/skill-mentions.ts";
import type { ExplicitSkill } from "../src/core/skills.ts";
const corpus = JSON.parse(
	readFileSync(new URL("./fixtures/codex-skill-mentions/corpus.json", import.meta.url), "utf8"),
);
for (const fixture of corpus.cases)
	it(`pinned mentions ${fixture.id}`, () => expect(extractSkillMentions(fixture.text)).toEqual(fixture.expected));
function identity(name: string, path: string): ExplicitSkill {
	return {
		name,
		canonicalPath: path,
		discoveryPath: path,
		skill: {
			name,
			filePath: path,
			baseDir: "/a",
			description: "",
			disableModelInvocation: true,
			sourceInfo: { path, source: "local" } as never,
		},
	};
}
it("paths precede names in inventory order, with canonical identity dedup", () => {
	const a = identity("a", "/a/SKILL.md"),
		b = identity("b", "/b/SKILL.md");
	expect(selectExplicitSkills("$a [$wrong](/b/SKILL.md) $b", [a, b, a])).toEqual([b, a]);
});
it("ambiguous names require a loaded path and cannot fall back from a wrong path", () => {
	const a = identity("same", "/a/SKILL.md"),
		b = identity("same", "/b/SKILL.md");
	expect(selectExplicitSkills("$same", [a, b])).toEqual([]);
	expect(selectExplicitSkills("[$same](/other)", [a])).toEqual([]);
	expect(selectExplicitSkills("[$x](/b/SKILL.md) [$x](/a/SKILL.md)", [a, b])).toEqual([a, b]);
});
it("connector slugs block plaintext but not explicit loaded paths", () => {
	const a = identity("demo", "/a/SKILL.md");
	expect(selectExplicitSkills("$demo", [a], new Map([["demo", 1]]))).toEqual([]);
	expect(selectExplicitSkills("[$x](/a/SKILL.md)", [a], new Map([["demo", 1]]))).toEqual([a]);
});
it("matches logical discovery aliases without resolving arbitrary input paths", () => {
	const a = {
		...identity("demo", "/real/SKILL.md"),
		discoveryPath: "/alias/SKILL.md",
	};
	expect(selectExplicitSkills("[$x](skill:///alias/SKILL.md)", [a])).toEqual([a]);
	expect(selectExplicitSkills("[$x](~/real/SKILL.md)", [a])).toEqual([]);
});
it("retains native user invocation restrictions for custom inventories", () => {
	const a = identity("a", "/a/SKILL.md");
	a.skill.userInvocable = false;
	expect(selectExplicitSkills("$a [$a](/a/SKILL.md)", [a])).toEqual([]);
});
