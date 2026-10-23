import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { extraSkillDirs, extraSkillsEnabled } from "../../src/octocode/skills.ts";
import { tmp } from "./helpers.ts";

describe("skills", () => {
	it("discovers only existing skill directories", () => {
		const home = tmp();
		fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
		expect(extraSkillDirs(tmp(), home)).toEqual([path.join(home, ".claude", "skills")]);
	});

	it("reads Octocode skills from OCTOCODE_HOME when set, else ~/.octocode/octocodecode", () => {
		const home = tmp();
		const custom = tmp();
		fs.mkdirSync(path.join(home, ".octocode", "octocodecode", "skills"), { recursive: true });
		fs.mkdirSync(path.join(custom, "skills"), { recursive: true });
		expect(extraSkillDirs(tmp(), home, true, {})).toEqual([path.join(home, ".octocode", "octocodecode", "skills")]);
		expect(extraSkillDirs(tmp(), home, true, { OCTOCODE_HOME: custom })).toEqual([path.join(custom, "skills")]);
	});

	it("loads extra skill directories only in the root session, unless turned off", () => {
		expect(extraSkillsEnabled({})).toBe(true);
		expect(extraSkillsEnabled({ OCTOCODE_SUBAGENT: "1" })).toBe(false);
		expect(extraSkillsEnabled({ OCTOCODE_EXTRA_SKILLS: "0" })).toBe(false);
	});

	it("adds project skill directories only for trusted projects", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".claude", "skills"), { recursive: true });
		expect(extraSkillDirs(cwd, tmp(), false)).toEqual([]);
		expect(extraSkillDirs(cwd, tmp(), true)).toEqual([path.join(cwd, ".claude", "skills")]);
	});

	it("finds project skills from a subdirectory up to the repository root", () => {
		const repo = tmp();
		fs.mkdirSync(path.join(repo, ".git"));
		fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
		const sub = path.join(repo, "packages", "a");
		fs.mkdirSync(path.join(sub, ".claude", "skills"), { recursive: true });
		expect(extraSkillDirs(sub, tmp(), true)).toEqual([
			path.join(sub, ".claude", "skills"),
			path.join(repo, ".claude", "skills"),
		]);
	});

	it("leaves the repository's .octocode/skills and the agent directory's skills to core discovery", () => {
		const repo = tmp();
		fs.mkdirSync(path.join(repo, ".git"));
		fs.mkdirSync(path.join(repo, ".octocode", "skills"), { recursive: true });
		fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
		const sub = path.join(repo, "packages", "a");
		fs.mkdirSync(sub, { recursive: true });
		// Loaded again here, their skills would escape the `skills` patterns and lose to user skills.
		expect(extraSkillDirs(sub, tmp(), true)).toEqual([path.join(repo, ".claude", "skills")]);
		const agentSkills = path.join(getAgentDir(), "skills");
		fs.mkdirSync(agentSkills, { recursive: true });
		expect(extraSkillDirs(tmp(), tmp(), true, { OCTOCODE_HOME: path.dirname(agentSkills) })).toEqual([]);
	});

	it("leaves out claude.ai's synced skills under ~/.claude/skills/synced, as Octocode loads the result", async () => {
		const home = tmp();
		const root = path.join(home, ".claude", "skills");
		const skill = (dir: string, name: string) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
		};
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
		const dirs = extraSkillDirs(tmp(), home);
		expect(dirs.sort()).toEqual([
			path.join(root, "group", "nested", "SKILL.md"),
			path.join(root, "local-one", "SKILL.md"),
			path.join(root, "loose.md"),
		]);
		// Octocode's own loader over these paths finds the local skills and none of the synced ones.
		const names = loadSkills({ cwd: tmp(), agentDir: tmp(), skillPaths: dirs, includeDefaults: false })
			.skills.map((s) => s.name)
			.sort();
		expect(names).toEqual(["local-one", "loose", "nested"]);
		// Without a synced folder, the skills folder is passed whole.
		fs.rmSync(path.join(root, "synced"), { recursive: true });
		expect(extraSkillDirs(tmp(), home)).toEqual([root]);
	});
});

it("keeps Claude parsing semantics through extra-directory and filtered-file discovery", () => {
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
		skillPaths: extraSkillDirs(cwd, home, false),
	});
	expect(loaded.skills).toHaveLength(1);
	expect(loaded.skills[0]).toMatchObject({
		description: "Description from the body.",
		userInvocable: false,
		argumentStyle: "claude",
	});
});
