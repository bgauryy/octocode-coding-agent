import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extractSkillMentions, extractSlashSkillNames, selectExplicitSkills } from "../src/core/skill-mentions.ts";
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
it("names skills by /name and /skill:name after the first token; the leading command is not a mention", () => {
	expect(extractSlashSkillNames("/a do X with /b, then /skill:c.")).toEqual(["b", "c"]);
	expect(extractSlashSkillNames('use /b\n(/c) and "/d" or `/e`')).toEqual(["b", "c", "d", "e"]);
	expect(extractSlashSkillNames(" /a leading space is not the command")).toEqual(["a"]);
});
it("never reads a path or URL as a slash mention", () => {
	expect(
		extractSlashSkillNames("see /tmp/x and src/a, /notes.md, ./b, https://x.dev/c, a/b, ~/d, /e/ and 1/2"),
	).toEqual([]);
});
it("selects several skills named by /name mid-input, once each, beside $name", () => {
	const a = identity("a", "/a/SKILL.md"),
		b = identity("b", "/b/SKILL.md"),
		c = identity("c", "/c/SKILL.md");
	expect(selectExplicitSkills("/a review with /b and $c, again /b", [a, b, c])).toEqual([b, c]);
	expect(selectExplicitSkills("fix it with /skill:a and /unknown", [a, b])).toEqual([a]);
	b.skill.userInvocable = false;
	expect(selectExplicitSkills("try /b", [b])).toEqual([]);
});
it("retains native user invocation restrictions for custom inventories", () => {
	const a = identity("a", "/a/SKILL.md");
	a.skill.userInvocable = false;
	expect(selectExplicitSkills("$a [$a](/a/SKILL.md)", [a])).toEqual([]);
});
