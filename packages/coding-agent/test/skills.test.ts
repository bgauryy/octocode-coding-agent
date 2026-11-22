import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { getNativeSkillsDir } from "../src/config.ts";
import { loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { SkillListing } from "../src/core/skills/listing.ts";
import { SKILL_SUMMARY_CHARS } from "../src/core/skills/summary.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
	scope?: "user" | "project" | "temporary";
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, {
			source: options.source ?? "test",
			...(options.scope ? { scope: options.scope } : {}),
		}),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it.skipIf(process.getuid?.() === 0)(
			"warns about a skill directory it cannot read instead of dropping it silently",
			() => {
				const root = mkdtempSync(join(tmpdir(), "octocode-skills-unreadable-"));
				const locked = join(root, "locked");
				mkdirSync(join(root, "open"), { recursive: true });
				mkdirSync(locked);
				writeFileSync(join(root, "open", "SKILL.md"), "---\nname: open\ndescription: Readable skill.\n---\nBody");
				chmodSync(locked, 0o000);
				try {
					const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });
					expect(skills.map((skill) => skill.name)).toEqual(["open"]);
					expect(diagnostics).toEqual([
						expect.objectContaining({ type: "warning", path: locked, message: expect.stringContaining("EACCES") }),
					]);
				} finally {
					chmodSync(locked, 0o755);
					rmSync(root, { recursive: true, force: true });
				}
			},
		);

		it("skips a skill whose metadata excludes this host, without a warning", () => {
			const root = mkdtempSync(join(tmpdir(), "octocode-skills-hosts-"));
			const skill = (name: string, hosts: string) => {
				mkdirSync(join(root, name));
				writeFileSync(
					join(root, name, "SKILL.md"),
					`---\nname: ${name}\ndescription: A skill.\nmetadata:\n  excluded-hosts: "${hosts}"\n---\nBody`,
				);
			};
			skill("elsewhere", "claude-code octocode-agent");
			skill("earlier-name", "octocode-code");
			skill("here", "claude-code");
			try {
				const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });
				expect(skills.map((loaded) => loaded.name)).toEqual(["here"]);
				expect(diagnostics).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory"))).toBe(
				false,
			);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("names loose Markdown files after themselves and needs frontmatter for them in a Claude root", () => {
			const root = mkdtempSync(join(tmpdir(), "octocode-skills-loose-"));
			try {
				writeFileSync(join(root, "deploy.md"), "---\ndescription: Deploy the app\n---\nSteps");
				writeFileSync(join(root, "rollback.md"), "---\ndescription: Roll back\n---\nSteps");
				const native = loadSkillsFromDir({ dir: root, source: "test" });
				expect(native.skills.map((skill) => skill.name).sort()).toEqual(["deploy", "rollback"]);
				expect(native.diagnostics.filter((diagnostic) => diagnostic.type === "collision")).toEqual([]);

				const claude = join(root, "claude");
				mkdirSync(join(claude, "real"), { recursive: true });
				writeFileSync(join(claude, "README.md"), "# My Claude skills\nNotes");
				writeFileSync(join(claude, "real", "SKILL.md"), "Real skill\nBody");
				const loaded = loadSkillsFromDir({ dir: claude, source: "test", protocol: "claude" });
				expect(loaded.skills.map((skill) => [skill.name, skill.description])).toEqual([["real", "Real skill"]]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(false);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});

	describe("SkillListing", () => {
		const entry = (name: string, filePath: string, extra: Partial<Parameters<typeof createTestSkill>[0]> = {}) =>
			createTestSkill({
				name,
				description: `${name} work.`,
				filePath,
				baseDir: dirname(filePath),
				...extra,
			});

		it("is empty for no skills, and when every skill is the user's alone", () => {
			expect(SkillListing.fromSkills([]).isEmpty).toBe(true);
			expect(SkillListing.fromSkills([]).render()).toBe("");
			const hidden = entry("hidden", "/p/hidden/SKILL.md", { disableModelInvocation: true });
			expect(SkillListing.fromSkills([hidden]).isEmpty).toBe(true);
		});

		it("lists a skill as its file and its description as written", () => {
			const skill = entry("test-skill", "/path/to/skill/SKILL.md", { description: 'A <test> & "skill".' });
			expect(SkillListing.fromSkills([skill]).render()).toContain('/path/to/skill/SKILL.md: A <test> & "skill".');
		});

		it("leaves out the skills only the user may run", () => {
			const listing = SkillListing.fromSkills([
				entry("visible", "/p/visible/SKILL.md"),
				entry("hidden", "/p/hidden/SKILL.md", { disableModelInvocation: true }),
			]);
			expect(listing.entries.map((item) => item.name)).toEqual(["visible"]);
			expect(listing.render()).not.toContain("hidden");
		});

		it("groups core, Octocode collection, workspace and global skills, in that order", () => {
			const listing = SkillListing.fromSkills([
				entry("mine", "/home/u/.agents/skills/mine/SKILL.md", { source: "auto", scope: "user" }),
				entry("repo-release", "/repo/.octocode/skills/repo-release/SKILL.md", { source: "auto", scope: "project" }),
				entry("octocode-roast", "/opt/octocode/skills/octocode-roast/SKILL.md", { source: "builtin", scope: "user" }),
				entry("octocode-debugging", join(getNativeSkillsDir(), "octocode-debugging", "SKILL.md")),
			]);
			expect(listing.groups.map((group) => group.category)).toEqual(["core", "octocode", "workspace", "global"]);
			expect(listing.groups.map((group) => group.entries.map((item) => item.name))).toEqual([
				["octocode-debugging"],
				["octocode-roast"],
				["repo-release"],
				["mine"],
			]);
			const text = listing.render();
			expect(text.split("\n").filter((line) => line.startsWith("<"))).toEqual([
				"<core_skills>",
				"</core_skills>",
				"<octocode_skills>",
				"</octocode_skills>",
				"<workspace_skills>",
				"</workspace_skills>",
				"<global_skills>",
				"</global_skills>",
			]);
			// An empty group is left out.
			expect(SkillListing.fromSkills([entry("mine", "/home/u/.agents/skills/mine/SKILL.md")]).render()).not.toMatch(
				/<core_skills>|<workspace_skills>/,
			);
		});

		it("states a bundled group's shared folder once and lists its skills relative to it; the full path and the name still load", () => {
			const one = join(getNativeSkillsDir(), "octocode-debugging", "SKILL.md");
			const two = join(getNativeSkillsDir(), "octocode-memory", "SKILL.md");
			const listing = SkillListing.fromSkills([
				entry("octocode-debugging", one, { description: "Debug." }),
				entry("octocode-memory", two, { description: "Remember." }),
				entry("mine", "/home/u/.agents/skills/mine/SKILL.md", { description: "Mine." }),
				entry("theirs", "/home/u/.agents/skills/theirs/SKILL.md", { description: "Theirs." }),
			]);
			const text = listing.render();
			expect(text).toContain(`<core_skills>\nroot: ${getNativeSkillsDir()}\n`);
			expect(text).toContain("octocode-debugging/SKILL.md: Debug.");
			expect(text).not.toContain(`${one}:`);
			// Workspace and global skills keep their full paths.
			expect(text).toContain("/home/u/.agents/skills/mine/SKILL.md: Mine.");
			expect(text).not.toContain("root: /home");
			for (const reference of ["octocode-debugging/SKILL.md", one, "octocode-debugging"])
				expect(listing.find(reference)?.name).toBe("octocode-debugging");
		});

		it("lists every skill with a bounded summary of its description, however many", () => {
			const skills = Array.from({ length: 500 }, (_, index) =>
				entry(`skill-${index}`, `/s/skill-${index}/SKILL.md`, { description: "d".repeat(2000) }),
			);
			const listing = SkillListing.fromSkills(skills);
			expect(listing.entries).toHaveLength(500);
			expect(listing.render()).toContain(`/s/skill-499/SKILL.md: ${"d".repeat(SKILL_SUMMARY_CHARS)}`);
			expect(listing.render()).not.toMatch(/…/);
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");
		const tempHomes: string[] = [];

		afterEach(() => {
			vi.unstubAllEnvs();
			for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
		});

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const home = mkdtempSync(join(tmpdir(), "octocode-skills-home-"));
			tempHomes.push(home);
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			const homeSkillsDir = join(home, ".octocode/agent/skills");
			mkdirSync(join(homeSkillsDir, "home-skill"), { recursive: true });
			writeFileSync(
				join(homeSkillsDir, "home-skill", "SKILL.md"),
				"---\nname: home-skill\ndescription: A skill in the home directory.\n---\n\n# Home Skill\n",
			);
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.octocode/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.map((skill) => skill.name)).toEqual(["home-skill"]);
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
