import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SKILL_CATALOG_ENV } from "@octocodeai/octocode-common/env";
import { getNativeSkillsDir, getOctocodeSkillsDir } from "../../src/config.ts";
import { formatSkillsForPrompt, loadSkills, type Skill } from "../../src/core/skills.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { GENERAL_CATALOG } from "../../src/octocode/subagents/general-defaults.ts";
import { loadProfiles, parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

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

	it("counts the user's own project and home skills it does not name instead of listing them", () => {
		const text = formatSkillsForPrompt([...all, own("mine", "project"), own("home", "user")], "skill", ["a"]);
		expect(text).toContain('<skill name="a">');
		for (const name of ["b", "mine", "home"]) expect(text).not.toContain(`name="${name}"`);
		expect(text).toMatch(/\b4 more skills\b/);
	});

	// The user's skills serve the main session: a child's prompt lists only its role's catalog.
	it("lists a user skill in the main session's prompt and leaves it out of a child's", async () => {
		const loaded = [...all, own("mine", "project"), own("home", "user")];
		const prompt = async (isSubagent: boolean, catalog?: string) => {
			vi.unstubAllEnvs();
			if (catalog !== undefined) vi.stubEnv(SKILL_CATALOG_ENV, catalog);
			const fake = fakeHost();
			registerTurnSetup(fake.api, { isSubagent, profiles: () => new Map() });
			const options = {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash", "file", "skill"],
				skills: loaded,
				contextFiles: [],
				cwd: "/repo",
			};
			await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
			return buildSystemPrompt(options);
		};
		try {
			const main = await prompt(false);
			for (const name of ["a", "mine", "home"]) expect(main).toContain(`<skill name="${name}">`);
			// A role with a catalog lists it; one without lists the bundled skills; neither lists the user's.
			const child = await prompt(true, "a");
			expect(child).toContain('<skill name="a">');
			for (const name of ["b", "mine", "home"]) expect(child).not.toContain(`name="${name}"`);
			const unset = await prompt(true);
			for (const name of ["a", "b", "c"]) expect(unset).toContain(`<skill name="${name}">`);
			for (const name of ["mine", "home"]) expect(unset).not.toContain(`name="${name}"`);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("reads `catalog:` from a profile as a list or a comma-separated string", () => {
		const front = (value: string) => `---\nname: r\ndescription: d\ncatalog: ${value}\n---\nbody`;
		expect(parseProfile("r", front("x, y")).catalog).toEqual(["x", "y"]);
		expect(parseProfile("r", front("[x, y]")).catalog).toEqual(["x", "y"]);
		expect(parseProfile("r", "---\nname: r\ndescription: d\n---\nbody").catalog).toBeUndefined();
	});
});

const collection = getOctocodeSkillsDir();

describe("bundled skill catalogs", () => {
	// The pack's names are checkable only where the research CLI package is installed.
	it.skipIf(collection === undefined)(
		"name only skills this host loads (core skills and the Octocode collection)",
		() => {
			const root = tmp();
			const { skills } = loadSkills({
				cwd: path.join(root, "project"),
				agentDir: path.join(root, "agent"),
				skillPaths: [getNativeSkillsDir(), collection!],
				includeDefaults: false,
			});
			const loadable = new Set(skills.map((skill) => skill.name));
			// A temporary home and an untrusted project leave only the bundled roles.
			const catalogs: Array<[string, readonly string[]]> = [
				["general", GENERAL_CATALOG],
				...[...loadProfiles(tmp(), tmp(), false, {}).values()].map((profile): [string, readonly string[]] => [
					profile.name,
					profile.catalog ?? [],
				]),
			];
			const missing = catalogs.flatMap(([role, names]) =>
				names.filter((name) => !loadable.has(name)).map((name) => `${role}: ${name}`),
			);
			expect(missing).toEqual([]);
		},
	);
});
