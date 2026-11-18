import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { parseProfile } from "../../src/octocode/subagents/profiles.ts";

/** A skill of the Octocode collection (source `builtin`), which a role's catalog narrows. */
const skill = (name: string, disableModelInvocation = false): Skill => ({
	name,
	description: `Use for ${name}.`,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "builtin" }),
	disableModelInvocation,
});
/** The user's own skill: a project one (`scope: project`) or one from their home folders. */
const own = (name: string, scope: "project" | "user"): Skill => ({
	...skill(name),
	sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "local", scope }),
});
const all = [skill("a"), skill("b"), skill("c"), skill("hidden", true)];

describe("a role's skill catalog", () => {
	it("lists only the named skills and counts the rest, not the ones reserved for the user", () => {
		const text = formatSkillsForPrompt(all, "skill", ["a"]);
		expect(text).toContain('<skill name="a">');
		expect(text).not.toContain('name="b"');
		expect(text).toMatch(/\b2 more skills\b/);
	});

	it("renders byte-identical blocks for siblings of one role and lists everything without a catalog", () => {
		expect(formatSkillsForPrompt(all, "skill", ["b", "a"])).toBe(formatSkillsForPrompt(all, "skill", ["a", "b"]));
		const full = formatSkillsForPrompt(all, "skill");
		for (const name of ["a", "b", "c"]) expect(full).toContain(`name="${name}"`);
		expect(full).not.toMatch(/more skills/);
	});

	it("still says how many skills exist when none of the named ones is installed", () => {
		const text = formatSkillsForPrompt(all, "skill", ["missing"]);
		expect(text).toMatch(/\b3 more skills\b/);
		expect(text).not.toContain("<skill ");
	});

	it("always lists the user's own project and home skills, whatever the catalog names", () => {
		const text = formatSkillsForPrompt([...all, own("mine", "project"), own("home", "user")], "skill", ["a"]);
		for (const name of ["a", "mine", "home"]) expect(text).toContain(`<skill name="${name}">`);
		expect(text).not.toContain('name="b"');
		expect(text).toMatch(/\b2 more skills\b/);
	});

	it("reads `catalog:` from a profile as a list or a comma-separated string", () => {
		const front = (value: string) => `---\nname: r\ndescription: d\ncatalog: ${value}\n---\nbody`;
		expect(parseProfile("r", front("x, y")).catalog).toEqual(["x", "y"]);
		expect(parseProfile("r", front("[x, y]")).catalog).toEqual(["x", "y"]);
		expect(parseProfile("r", "---\nname: r\ndescription: d\n---\nbody").catalog).toBeUndefined();
	});
});
