import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { getNativeSkillsDir } from "../src/config.ts";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
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
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
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
			skill("elsewhere", "claude-code octocode-code");
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

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
			// One line per skill: name, description as written, and the file a file reader loads.
			expect(result).toContain(
				"  <skill><name>test-skill</name><description>A test skill.</description><location>/path/to/skill/SKILL.md</location></skill>",
			);
		});

		it("omits file paths when the skill tool loads skills by name", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills, "skill");

			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).not.toContain("<location>");
			expect(result).not.toContain("/path/to/skill");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			// One intro line, the load instruction. Octocode ships no `read` tool; bash is the default loader.
			expect(introText.trim().split("\n")[0]).toBe(
				"Use bash to load a skill's file when the task matches its description.",
			);
		});

		it("groups Octocode's core skills, the bundled Octocode collection and external skills, in that order", () => {
			const skill = (name: string, dir: string, source?: string) =>
				createTestSkill({
					name,
					description: `${name} work.`,
					filePath: join(dir, name, "SKILL.md"),
					baseDir: join(dir, name),
					source,
				});
			const result = formatSkillsForPrompt(
				[
					skill("mine", "/home/u/.agents/skills"),
					skill("octocode-research", "/opt/octocode/skills", "builtin"),
					skill("octocode-debugging", getNativeSkillsDir()),
				],
				"skill",
			);
			const catalog = result.slice(result.indexOf("<available_skills>"));
			const tags = catalog.split("\n").filter((line) => !line.startsWith("  <skill>"));
			expect(tags).toEqual([
				"<available_skills>",
				"<core_skills>",
				"</core_skills>",
				"<octocode_skills>",
				"</octocode_skills>",
				"<external_skills>",
				"</external_skills>",
				"</available_skills>",
			]);
			const order = ["octocode-debugging", "octocode-research", "mine"].map((name) =>
				catalog.indexOf(`<name>${name}</name>`),
			);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(catalog).toMatch(/<core_skills>\n {2}<skill><name>octocode-debugging<\/name>/);
			// A catalog with only external skills has only that group.
			expect(formatSkillsForPrompt([skill("mine", "/home/u/.agents/skills")], "skill")).not.toMatch(
				/<core_skills>|<octocode_skills>/,
			);
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});

		describe("budget", () => {
			const many = (count: number, description = "d".repeat(200)) =>
				Array.from({ length: count }, (_, index) =>
					createTestSkill({
						name: `skill-${index}`,
						description,
						filePath: `/s/skill-${index}/SKILL.md`,
						baseDir: `/s/skill-${index}`,
					}),
				);
			const entries = (text: string) =>
				text.slice(text.indexOf("<available_skills>"), text.indexOf("</available_skills>"));

			it("lists everything unchanged within the budget", () => {
				const result = formatSkillsForPrompt(many(5), "bash");
				expect((result.match(/<description>/g) ?? []).length).toBe(5);
				expect(result).not.toContain("to fit the prompt");
			});

			it("drops descriptions from the last skills first and says so", () => {
				const result = formatSkillsForPrompt(many(10), "bash", { budgetChars: 2000 });
				expect(entries(result).length).toBeLessThanOrEqual(2000 + "<available_skills>".length);
				expect(result).toContain("<name>skill-9</name>");
				expect(result).toMatch(/<name>skill-0<\/name><description>/);
				expect(result).toMatch(/<name>skill-9<\/name><location>/);
				expect(result).toMatch(/To fit the prompt, \d+ skills are listed without a description/);
			});

			it("bounds overflow names and reports how many remain when bare entries do not fit", () => {
				const result = formatSkillsForPrompt(many(100), "bash", { budgetChars: 1000 });
				expect(result).toContain("<name>skill-0</name>");
				expect(result).toMatch(/\d+ skills are outside the XML list .*skill-\d+.*; \d+ more$/);
				expect(result).not.toContain("skill-99");
				const overflow = result.split("asks for one): ")[1] ?? "";
				expect(entries(result).length - "<available_skills>".length + overflow.length).toBeLessThanOrEqual(1000);
			});

			it("keeps a very large catalog bounded instead of appending every omitted name", () => {
				const result = formatSkillsForPrompt(many(10_000), "skill");
				expect(result.length).toBeLessThan(9000);
				expect(result).toContain("skills are outside the XML list");
				expect(result).toMatch(/\d+ more$/);
				expect(result).not.toContain("skill-9999");
			});

			it("cuts a description over the Agent Skills limit", () => {
				const result = formatSkillsForPrompt(many(1, "x".repeat(3000)), "bash");
				const description = /<description>(.*)<\/description>/.exec(result)?.[1] ?? "";
				expect(description.length).toBe(1024);
				expect(description.endsWith("…")).toBe(true);
			});
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
