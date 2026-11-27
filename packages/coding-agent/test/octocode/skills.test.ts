import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { externalSkillsEnabled as extraSkillsEnabled } from "../../src/core/discovery/sources.ts";
import { tmp, vendorSkillFiles } from "./helpers.ts";

const skill = (dir: string, name: string) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
	return path.join(dir, "SKILL.md");
};

/** Octocode's global skill files outside the agent directory, as discovery lists them. */
const octocodeHomeSkills = (home: string, env: NodeJS.ProcessEnv) =>
	configDiscovery
		.discover("skill", discoveryInput({ cwd: tmp(), agentDir: tmp(), home, projectTrusted: true, env, piRoots: [] }))
		.filter((item) => item.provenance.vendor === "octocode")
		.map((item) => item.provenance.path);

describe("skills", () => {
	it("lists the skills other agents' folders hold, and nothing for an empty folder", () => {
		const home = tmp();
		fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
		expect(vendorSkillFiles(tmp(), home)).toEqual([]);
		const file = skill(path.join(home, ".claude", "skills", "one"), "one");
		expect(vendorSkillFiles(tmp(), home)).toEqual([file]);
	});

	it("reads Octocode skills from OCTOCODE_HOME when set, else ~/.octocode/octocodecode", () => {
		const home = tmp();
		const custom = tmp();
		const defaultSkill = skill(path.join(home, ".octocode", "octocodecode", "skills", "a"), "a");
		const customSkill = skill(path.join(custom, "skills", "b"), "b");
		expect(octocodeHomeSkills(home, {})).toEqual([defaultSkill]);
		expect(octocodeHomeSkills(home, { OCTOCODE_HOME: custom })).toEqual([customSkill]);
	});

	it("loads extra skill directories only in the root session, unless turned off", () => {
		expect(extraSkillsEnabled({})).toBe(true);
		expect(extraSkillsEnabled({ OCTOCODE_SUBAGENT: "1" })).toBe(false);
		expect(extraSkillsEnabled({ OCTOCODE_EXTRA_SKILLS: "0" })).toBe(false);
		const home = tmp();
		skill(path.join(home, ".claude", "skills", "one"), "one");
		expect(vendorSkillFiles(tmp(), home, true, { OCTOCODE_EXTRA_SKILLS: "0" })).toEqual([]);
	});

	it("adds project skills only for trusted projects", () => {
		const cwd = tmp();
		const file = skill(path.join(cwd, ".claude", "skills", "p"), "p");
		expect(vendorSkillFiles(cwd, tmp(), false)).toEqual([]);
		expect(vendorSkillFiles(cwd, tmp(), true)).toEqual([file]);
	});

	it("finds project skills from a subdirectory up to the repository root, and none above it", () => {
		const outer = tmp();
		skill(path.join(outer, ".claude", "skills", "outside"), "outside");
		const repo = path.join(outer, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		const root = skill(path.join(repo, ".claude", "skills", "r"), "r");
		const sub = path.join(repo, "packages", "a");
		const nested = skill(path.join(sub, ".claude", "skills", "s"), "s");
		expect(vendorSkillFiles(sub, tmp(), true)).toEqual([nested, root]);
	});

	it("leaves out claude.ai's synced skills under ~/.claude/skills/synced, as Octocode loads the result", () => {
		const home = tmp();
		const root = path.join(home, ".claude", "skills");
		skill(path.join(root, "local-one"), "local-one");
		skill(path.join(root, "group", "nested"), "nested");
		skill(path.join(root, "synced", "docx"), "docx");
		skill(path.join(root, "synced", "deep", "pptx"), "pptx");
		fs.writeFileSync(path.join(root, "loose.md"), "---\nname: loose\ndescription: loose skill\n---\nBody\n");
		fs.writeFileSync(
			path.join(root, "group", "extra.md"),
			"---\nname: extra\ndescription: nested loose file\n---\nBody\n",
		);
		skill(path.join(root, "ignored"), "ignored");
		fs.writeFileSync(path.join(root, ".ignore"), "ignored/\n");
		fs.writeFileSync(path.join(root, "notes.txt"), "not a skill");
		fs.mkdirSync(path.join(root, ".hidden"));
		const files = vendorSkillFiles(tmp(), home);
		expect([...files].sort()).toEqual([
			path.join(root, "group", "nested", "SKILL.md"),
			path.join(root, "local-one", "SKILL.md"),
			path.join(root, "loose.md"),
		]);
		const names = loadSkills({ cwd: tmp(), agentDir: tmp(), skillPaths: files, includeDefaults: false })
			.skills.map((s) => s.name)
			.sort();
		expect(names).toEqual(["local-one", "loose", "nested"]);
	});
});

it("keeps Claude parsing semantics for discovered Claude skill files", () => {
	const home = tmp();
	const cwd = tmp();
	const root = path.join(home, ".claude", "skills");
	fs.mkdirSync(path.join(root, "example"), { recursive: true });
	fs.mkdirSync(path.join(root, "synced"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "example", "SKILL.md"),
		'---\nname: example\nuser-invocable: "no"\n---\nDescription from the body.\n$0',
	);
	const loaded = loadSkills({
		cwd,
		agentDir: tmp(),
		includeDefaults: false,
		skillPaths: vendorSkillFiles(cwd, home, false),
	});
	expect(loaded.skills).toHaveLength(1);
	expect(loaded.skills[0]).toMatchObject({
		description: "Description from the body.",
		userInvocable: false,
		argumentStyle: "claude",
	});
});
