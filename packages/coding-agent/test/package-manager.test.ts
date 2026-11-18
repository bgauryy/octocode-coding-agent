import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ProgressEvent, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
}

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	getPackageManagerName(): string;
	getGitDependencyInstallArgs(): string[];
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	getLocalGitUpdateTarget(installedPath: string): Promise<{ ref: string; head: string; fetchArgs: string[] }>;
	parseSource(
		source: string,
	):
		| { type: "npm"; spec: string; name: string; pinned: boolean }
		| { type: "git"; repo: string; host: string; path: string; pinned: boolean; ref?: string }
		| { type: "local"; path: string };
	getNpmInstallPath(
		source: { type: "npm"; spec: string; name: string; pinned: boolean },
		scope: "user" | "project" | "temporary",
	): string;
	getGitInstallPath(
		source: { type: "git"; repo: string; host: string; path: string; pinned: boolean; ref?: string },
		scope: "user" | "project" | "temporary",
	): string;
}

function updateMarkerPath(targetDir: string): string {
	return join(dirname(targetDir), `.${basename(targetDir)}.octocode-update-incomplete`);
}

function expectManagedNpmProject(installRoot: string): void {
	expect(JSON.parse(readFileSync(join(installRoot, "package.json"), "utf-8"))).toEqual({
		name: "octocode-packages",
		private: true,
	});
	expect(readFileSync(join(installRoot, ".gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
}

// Helper to check if a resource is enabled
const isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !r.enabled
		: normalizedPath.includes(normalizedMatch) && !r.enabled;
};

describe("DefaultPackageManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.OCTOCODE_OFFLINE;
		delete process.env.OCTOCODE_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.OCTOCODE_OFFLINE;
		} else {
			process.env.OCTOCODE_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolve", () => {
		it("should resolve skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(
				skillFile,
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			// Skills with SKILL.md are returned as file paths
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover root markdown skills from .pi skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(
				skillFile,
				`---
name: single-file
description: A root markdown skill
---
Content`,
			);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover user prompts with overrides", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "auto.md");
			writeFileSync(promptPath, "Auto prompt");

			settingsManager.setPromptTemplatePaths(["!prompts/auto.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should auto-discover project prompts with overrides", async () => {
			const promptsDir = join(tempDir, ".octocode", "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "is.md");
			writeFileSync(promptPath, "Is prompt");

			settingsManager.setProjectPromptTemplatePaths(["!prompts/is.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});
	});

	describe("auto-discovered skill metadata", () => {
		it("should use the agent dir as baseDir for user .octocode/agent skills", async () => {
			const skillPath = join(agentDir, "skills", "user-pi", "SKILL.md");
			mkdirSync(join(agentDir, "skills", "user-pi"), { recursive: true });
			writeFileSync(skillPath, "---\nname: user-pi\ndescription: user pi\n---\n");

			const result = await packageManager.resolve();
			const skill = result.skills.find((r) => r.path === skillPath);

			expect(skill?.metadata.source).toBe("auto");
			expect(skill?.metadata.scope).toBe("user");
			expect(skill?.metadata.baseDir).toBe(agentDir);
		});

		it("should use the project .pi dir as baseDir for project .pi skills", async () => {
			const projectBaseDir = join(tempDir, ".octocode");
			const skillPath = join(projectBaseDir, "skills", "project-pi", "SKILL.md");
			mkdirSync(join(projectBaseDir, "skills", "project-pi"), { recursive: true });
			writeFileSync(skillPath, "---\nname: project-pi\ndescription: project pi\n---\n");

			const result = await packageManager.resolve();
			const skill = result.skills.find((r) => r.path === skillPath);

			expect(skill?.metadata.source).toBe("auto");
			expect(skill?.metadata.scope).toBe("project");
			expect(skill?.metadata.baseDir).toBe(projectBaseDir);
		});

		it("should use ~/.agents as baseDir for user .agents skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentsBaseDir = join(tempDir, ".agents");
				const skillPath = join(agentsBaseDir, "skills", "user-agents", "SKILL.md");
				mkdirSync(join(agentsBaseDir, "skills", "user-agents"), { recursive: true });
				writeFileSync(skillPath, "---\nname: user-agents\ndescription: user agents\n---\n");

				const result = await packageManager.resolve();
				const skill = result.skills.find((r) => r.path === skillPath);

				expect(skill?.metadata.source).toBe("auto");
				expect(skill?.metadata.scope).toBe("user");
				expect(skill?.metadata.baseDir).toBe(agentsBaseDir);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should use each project .agents dir as baseDir for project .agents skills", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const repoAgentsBaseDir = join(repoRoot, ".agents");
			const repoSkill = join(repoAgentsBaseDir, "skills", "repo", "SKILL.md");
			mkdirSync(join(repoAgentsBaseDir, "skills", "repo"), { recursive: true });
			writeFileSync(repoSkill, "---\nname: repo\ndescription: repo\n---\n");

			const packageAgentsBaseDir = join(repoRoot, "packages", ".agents");
			const packageSkill = join(packageAgentsBaseDir, "skills", "package", "SKILL.md");
			mkdirSync(join(packageAgentsBaseDir, "skills", "package"), { recursive: true });
			writeFileSync(packageSkill, "---\nname: package\ndescription: package\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			const resolvedRepoSkill = result.skills.find((r) => r.path === repoSkill);
			const resolvedPackageSkill = result.skills.find((r) => r.path === packageSkill);

			expect(resolvedRepoSkill?.metadata.source).toBe("auto");
			expect(resolvedRepoSkill?.metadata.scope).toBe("project");
			expect(resolvedRepoSkill?.metadata.baseDir).toBe(repoAgentsBaseDir);
			expect(resolvedPackageSkill?.metadata.source).toBe("auto");
			expect(resolvedPackageSkill?.metadata.scope).toBe("project");
			expect(resolvedPackageSkill?.metadata.baseDir).toBe(packageAgentsBaseDir);
		});
	});

	describe(".agents/skills auto-discovery", () => {
		it("should scan .agents/skills from cwd up to git repo root", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const aboveRepoSkill = join(tempDir, ".agents", "skills", "above-repo", "SKILL.md");
			mkdirSync(join(tempDir, ".agents", "skills", "above-repo"), { recursive: true });
			writeFileSync(aboveRepoSkill, "---\nname: above-repo\ndescription: above\n---\n");

			const repoRootSkill = join(repoRoot, ".agents", "skills", "repo-root", "SKILL.md");
			mkdirSync(join(repoRoot, ".agents", "skills", "repo-root"), { recursive: true });
			writeFileSync(repoRootSkill, "---\nname: repo-root\ndescription: repo\n---\n");

			const nestedSkill = join(repoRoot, "packages", ".agents", "skills", "nested", "SKILL.md");
			mkdirSync(join(repoRoot, "packages", ".agents", "skills", "nested"), { recursive: true });
			writeFileSync(nestedSkill, "---\nname: nested\ndescription: nested\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === repoRootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === aboveRepoSkill)).toBe(false);
		});

		it("should scan .agents/skills up to filesystem root when not in a git repo", async () => {
			const nonRepoRoot = join(tempDir, "non-repo");
			const nestedCwd = join(nonRepoRoot, "a", "b");
			mkdirSync(nestedCwd, { recursive: true });

			const rootSkill = join(nonRepoRoot, ".agents", "skills", "root", "SKILL.md");
			mkdirSync(join(nonRepoRoot, ".agents", "skills", "root"), { recursive: true });
			writeFileSync(rootSkill, "---\nname: root\ndescription: root\n---\n");

			const middleSkill = join(nonRepoRoot, "a", ".agents", "skills", "middle", "SKILL.md");
			mkdirSync(join(nonRepoRoot, "a", ".agents", "skills", "middle"), { recursive: true });
			writeFileSync(middleSkill, "---\nname: middle\ndescription: middle\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === middleSkill && r.enabled)).toBe(true);
		});

		it("should ignore root markdown files in .agents/skills but discover nested markdown skills", async () => {
			const agentsSkillsDir = join(tempDir, ".agents", "skills");
			mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
			mkdirSync(join(agentsSkillsDir, "third-party"), { recursive: true });
			mkdirSync(join(agentsSkillsDir, "third-party", "vendor", "pack"), { recursive: true });
			const rootSkill = join(agentsSkillsDir, "root-file.md");
			const nestedSkill = join(agentsSkillsDir, "nested-skill", "SKILL.md");
			const nestedMarkdownSkill = join(agentsSkillsDir, "third-party", "child-skill.md");
			const deeplyNestedMarkdownSkill = join(agentsSkillsDir, "third-party", "vendor", "pack", "deep-skill.md");
			writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");
			writeFileSync(nestedMarkdownSkill, "---\nname: child-skill\ndescription: Nested markdown skill\n---\n");
			writeFileSync(deeplyNestedMarkdownSkill, "---\nname: deep-skill\ndescription: Deep markdown skill\n---\n");

			const pm = new DefaultPackageManager({
				cwd: join(tempDir, "work"),
				agentDir,
				settingsManager,
			});
			mkdirSync(join(tempDir, "work"), { recursive: true });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedMarkdownSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === deeplyNestedMarkdownSkill && r.enabled)).toBe(true);
		});

		it("should keep ~/.agents/skills user-scoped when cwd is under home in a non-git directory", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const cwd = join(tempDir, "scratch", "nested");
				const localAgentDir = join(tempDir, ".octocode", "agent");
				const localSettingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
				mkdirSync(cwd, { recursive: true });
				mkdirSync(localAgentDir, { recursive: true });

				const homeSkill = join(tempDir, ".agents", "skills", "home-skill", "SKILL.md");
				mkdirSync(join(tempDir, ".agents", "skills", "home-skill"), { recursive: true });
				writeFileSync(homeSkill, "---\nname: home-skill\ndescription: home\n---\n");

				const pm = new DefaultPackageManager({
					cwd,
					agentDir: localAgentDir,
					settingsManager: localSettingsManager,
				});

				const result = await pm.resolve();
				const matchingSkills = result.skills.filter((r) => r.path === homeSkill);
				expect(matchingSkills).toHaveLength(1);
				expect(matchingSkills[0]?.enabled).toBe(true);
				expect(matchingSkills[0]?.metadata.scope).toBe("user");
				expect(matchingSkills[0]?.metadata.source).toBe("auto");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should dedupe user skill entries when ~/.octocode/agent/skills is a symlink to ~/.agents/skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentSkillsDir = join(agentDir, "skills");
				const agentsSkillsDir = join(tempDir, ".agents", "skills");
				mkdirSync(agentsSkillsDir, { recursive: true });
				// Use junction on Windows to avoid EPERM when symlink privileges are unavailable.
				const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
				symlinkSync(agentsSkillsDir, agentSkillsDir, directoryLinkType);

				const skillPath = join(agentsSkillsDir, "foo", "SKILL.md");
				mkdirSync(join(agentsSkillsDir, "foo"), { recursive: true });
				writeFileSync(skillPath, "---\nname: foo\ndescription: foo\n---\n");

				const result = await packageManager.resolve();
				const fooSkills = result.skills.filter((r) => pathEndsWith(r.path, "foo/SKILL.md"));

				expect(fooSkills).toHaveLength(1);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe("ignore files", () => {
		it("should respect .gitignore in skill directories", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n__pycache__\n");

			const goodSkillDir = join(skillsDir, "good-skill");
			mkdirSync(goodSkillDir, { recursive: true });
			writeFileSync(join(goodSkillDir, "SKILL.md"), "---\nname: good-skill\ndescription: Good\n---\nContent");

			const ignoredSkillDir = join(skillsDir, "venv", "bad-skill");
			mkdirSync(ignoredSkillDir, { recursive: true });
			writeFileSync(join(ignoredSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path.includes("good-skill") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path.includes("venv") && r.enabled)).toBe(false);
		});

		it("should not apply parent .gitignore to .pi auto-discovery", async () => {
			writeFileSync(join(tempDir, ".gitignore"), ".pi\n");

			const skillDir = join(tempDir, ".octocode", "skills", "auto-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillPath = join(skillDir, "SKILL.md");
			writeFileSync(skillPath, "---\nname: auto-skill\ndescription: Auto\n---\nContent");

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillPath && r.enabled)).toBe(true);
		});
	});

	describe("resolveSources", () => {
		it("should stop recursing when a package skill directory contains SKILL.md", async () => {
			const pkgDir = join(tempDir, "skill-root-pkg");
			mkdirSync(join(pkgDir, "skills", "root-skill", "nested-skill"), { recursive: true });
			const rootSkill = join(pkgDir, "skills", "root-skill", "SKILL.md");
			const nestedSkill = join(pkgDir, "skills", "root-skill", "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-skill\ndescription: Root skill\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const result = await packageManager.resolveSources([pkgDir]);
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill)).toBe(false);
		});
	});

	describe("progress callback", () => {
		it("should emit progress events", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			// Local paths don't trigger install progress, but we can verify the callback is set
			await packageManager.resolveSources([extPath]);

			// For now just verify no errors - npm/git would trigger actual events
			expect(events.length).toBe(0);
		});
	});

	describe("command spawning", () => {
		it("should preserve argv entries containing spaces", () => {
			const managerWithInternals = packageManager as unknown as {
				runCommandSync(command: string, args: string[]): string;
			};
			const valueWithSpace = "C:\\Users\\A B\\.pi\\npm";
			const output = managerWithInternals.runCommandSync(process.execPath, [
				"-e",
				"console.log(process.argv[1])",
				valueWithSpace,
			]);

			expect(output).toBe(valueWithSpace);
		});
	});

	describe("npmCommand with real processes", () => {
		// Real `git` against local remotes (github.com is redirected to them with `url.<base>.insteadOf`); `npm`, `pnpm`,
		// `bun`, `corepack` and `mise` are small executables first on PATH that record their argv and working directory.
		const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
		const ENV_KEYS = [
			"PATH",
			"PM_FAKE_LOG",
			"PM_FAIL",
			"PM_REAL_GIT",
			"PM_GIT_FAIL_BEFORE",
			"PM_GIT_FAIL_AFTER",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"PM_ROOT_node_20",
			"PM_ROOT_node_22",
			"PM_SCRIPT_npm",
			"PM_SCRIPT_pnpm",
			"PM_SCRIPT_mise",
			"PM_DELAY_npm",
			"PM_GIT_DELAY_FETCH",
		];
		let savedEnv: Record<string, string | undefined>;
		let binDir: string;
		let remotes: string;
		let logFile: string;

		const FAKE_TOOL = (name: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PM_FAKE_LOG, JSON.stringify({ tool: ${JSON.stringify(name)}, args, cwd: process.cwd() }) + "\\n");
if ((process.env.PM_FAIL || "").split(",").includes(${JSON.stringify(name)})) {
	console.error("simulated ${name} failure");
	process.exit(1);
}
const start = Date.now();
const code = process.env["PM_SCRIPT_" + ${JSON.stringify(name)}];
if (code) new Function("args", "fs", "require", code)(args, fs, require);
const delay = Number(process.env["PM_DELAY_" + ${JSON.stringify(name)}] || 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
fs.appendFileSync(process.env.PM_FAKE_LOG + ".spans", JSON.stringify({ tool: ${JSON.stringify(name)}, args, start, end: Date.now() }) + "\\n");
if (${JSON.stringify(name)} === "mise") {
	const version = args.find((arg) => arg.startsWith("node@"));
	const root = version && process.env["PM_ROOT_" + version.replace(/\\W/g, "_").replace("@", "_")];
	if (args.includes("root") && root) console.log(root);
}
`;
		// Real git, with a hook for a failure before or after one subcommand (a clone that left its folder, a clean that failed).
		const GIT_WRAPPER = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PM_FAKE_LOG, JSON.stringify({ tool: "git", args, cwd: process.cwd() }) + "\\n");
if (process.env.PM_GIT_FAIL_BEFORE === args[0]) {
	console.error("simulated git " + args[0] + " failure");
	process.exit(1);
}
const start = Date.now();
if (args[0] === "fetch" && process.env.PM_GIT_DELAY_FETCH) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PM_GIT_DELAY_FETCH));
const result = spawnSync(process.env.PM_REAL_GIT, args, { stdio: "inherit" });
fs.appendFileSync(process.env.PM_FAKE_LOG + ".spans", JSON.stringify({ tool: "git", args, start, end: Date.now() }) + "\\n");
if (process.env.PM_GIT_FAIL_AFTER === args[0]) {
	console.error("simulated git " + args[0] + " failure");
	process.exit(1);
}
process.exit(result.status ?? 1);
`;

		const git = (cwd: string, ...args: string[]): string =>
			execFileSync(REAL_GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
				cwd,
				encoding: "utf-8",
			}).trim();

		/** A local repository standing in for github.com/user/repo, with its first commit on `main`. */
		function createRemote(
			files: Record<string, string | null> = { "package.json": JSON.stringify({ name: "repo", version: "1.0.0" }) },
			name = "user/repo",
		) {
			const dir = join(remotes, ...name.split("/"));
			mkdirSync(dir, { recursive: true });
			git(dir, "init", "-q", "-b", "main");
			commit(dir, files, "first");
			return dir;
		}
		function commit(dir: string, files: Record<string, string | null>, message: string): string {
			for (const [name, content] of Object.entries(files)) {
				if (content === null) {
					rmSync(join(dir, name), { force: true });
					continue;
				}
				mkdirSync(dirname(join(dir, name)), { recursive: true });
				writeFileSync(join(dir, name), content);
			}
			git(dir, "add", ".");
			git(dir, "commit", "-q", "-m", message);
			return git(dir, "rev-parse", "HEAD");
		}
		/** What the fake tools and the git wrapper recorded, oldest first. */
		const calls = (tool?: string): Array<{ tool: string; args: string[]; cwd: string }> =>
			(existsSync(logFile) ? readFileSync(logFile, "utf-8").split("\n").filter(Boolean) : [])
				.map((line) => JSON.parse(line))
				.filter((entry) => tool === undefined || entry.tool === tool);
		const managerWith = (settings: Record<string, unknown> = {}) => {
			settingsManager = SettingsManager.inMemory(settings, { projectTrusted: true });
			packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
			return packageManager;
		};
		const gitDir = (...parts: string[]) => join(agentDir, "git", "github.com", "user", "repo", ...parts);
		const projectGitDir = () => join(tempDir, ".octocode", "git", "github.com", "user", "repo");
		/** The checkout `install` would have made, cloned for real from the remote at its current state. */
		function clonedCheckout(target: string, remote: string): void {
			mkdirSync(dirname(target), { recursive: true });
			git(tempDir, "clone", "-q", remote, target);
		}
		const NPM_GIT_INSTALL = ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts"];
		const PNPM_GIT_INSTALL = [
			"install",
			"--prod",
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
			"--ignore-scripts",
		];

		beforeEach(() => {
			savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
			binDir = join(tempDir, "bin");
			remotes = join(tempDir, "remotes");
			logFile = join(tempDir, "tools.log");
			mkdirSync(binDir, { recursive: true });
			for (const name of ["npm", "pnpm", "bun", "corepack", "mise"]) {
				writeFileSync(join(binDir, name), FAKE_TOOL(name), { mode: 0o755 });
			}
			writeFileSync(join(binDir, "git"), GIT_WRAPPER, { mode: 0o755 });
			process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
			process.env.PM_FAKE_LOG = logFile;
			process.env.PM_REAL_GIT = REAL_GIT;
			process.env.PM_ROOT_node_20 = join(tempDir, "node20", "lib", "node_modules");
			process.env.PM_ROOT_node_22 = join(tempDir, "node22", "lib", "node_modules");
			for (const key of [
				"PM_FAIL",
				"PM_SCRIPT_npm",
				"PM_SCRIPT_pnpm",
				"PM_SCRIPT_mise",
				"PM_DELAY_npm",
				"PM_GIT_DELAY_FETCH",
			])
				delete process.env[key];
			delete process.env.PM_GIT_FAIL_BEFORE;
			delete process.env.PM_GIT_FAIL_AFTER;
			process.env.GIT_CONFIG_COUNT = "1";
			process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`;
			process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
		});

		afterEach(() => {
			for (const key of ENV_KEYS) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
		});

		it("should use npmCommand argv for npm installs", async () => {
			const pm = managerWith({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] });

			await pm.install("npm:@scope/pkg");

			expectManagedNpmProject(join(agentDir, "npm"));
			expect(calls().map(({ tool, args }) => [tool, args])).toEqual([
				[
					"mise",
					[
						"exec",
						"node@20",
						"--",
						"npm",
						"install",
						"@scope/pkg",
						"--prefix",
						join(agentDir, "npm"),
						"--legacy-peer-deps",
						"--ignore-scripts",
					],
				],
			]);
		});

		it("should pass legacy peer deps when uninstalling npm packages", async () => {
			mkdirSync(join(agentDir, "npm"), { recursive: true });
			managerWith();

			await packageManager.remove("npm:@scope/pkg");

			expect(calls().map(({ tool, args }) => [tool, args])).toEqual([
				["npm", ["uninstall", "@scope/pkg", "--prefix", join(agentDir, "npm"), "--legacy-peer-deps"]],
			]);
		});

		it("should use bun --cwd for npm package installs", async () => {
			const pm = managerWith({ npmCommand: ["mise", "exec", "bun@1", "--", "bun"] });

			await pm.install("npm:@scope/pkg");

			expectManagedNpmProject(join(agentDir, "npm"));
			expect(calls().map(({ tool, args }) => [tool, args])).toEqual([
				[
					"mise",
					[
						"exec",
						"bun@1",
						"--",
						"bun",
						"install",
						"@scope/pkg",
						"--cwd",
						join(agentDir, "npm"),
						"--omit=peer",
						"--ignore-scripts",
					],
				],
			]);
		});

		it("should install git package dependencies without auto-installing peers", async () => {
			createRemote();
			managerWith();

			await packageManager.install("git:github.com/user/repo");

			expect(readFileSync(join(agentDir, "git", ".gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
			expect(JSON.parse(readFileSync(gitDir("package.json"), "utf-8"))).toMatchObject({ name: "repo" });
			expect(existsSync(updateMarkerPath(gitDir()))).toBe(false);
			expect(calls("npm")).toEqual([{ tool: "npm", args: NPM_GIT_INSTALL, cwd: realpathSync(gitDir()) }]);
		});

		it("should remove a newly created checkout when git clone fails", async () => {
			createRemote();
			process.env.PM_GIT_FAIL_AFTER = "clone"; // the clone leaves its folder behind, then reports failure
			managerWith();

			await expect(packageManager.install("git:github.com/user/repo")).rejects.toThrow(
				/git clone .* failed with code 1/,
			);

			expect(existsSync(gitDir())).toBe(false);
		});

		it("should remove a newly cloned checkout when dependency installation fails", async () => {
			createRemote();
			process.env.PM_FAIL = "npm";
			managerWith();

			await expect(packageManager.install("git:github.com/user/repo")).rejects.toThrow(
				"npm install --omit=dev --legacy-peer-deps --ignore-scripts failed with code 1",
			);

			expect(existsSync(gitDir())).toBe(false);
		});

		it("should reconcile an existing git checkout to a pinned ref during install", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0" }),
				"notes.txt": "one",
			});
			clonedCheckout(gitDir(), remote);
			const second = commit(remote, { "notes.txt": "two" }, "second");
			git(remote, "tag", "v2");
			commit(remote, { "notes.txt": "three" }, "third");
			writeFileSync(gitDir("stray.txt"), "left over");
			managerWith();

			await packageManager.install("git:github.com/user/repo@v2");

			// The checkout sits on the pinned commit, a clean tree, no incomplete-update marker, dependencies reinstalled.
			expect(git(gitDir(), "rev-parse", "HEAD")).toBe(second);
			expect(readFileSync(gitDir("notes.txt"), "utf-8")).toBe("two");
			expect(existsSync(gitDir("stray.txt"))).toBe(false);
			expect(existsSync(updateMarkerPath(gitDir()))).toBe(false);
			expect(calls("npm")).toEqual([{ tool: "npm", args: NPM_GIT_INSTALL, cwd: realpathSync(gitDir()) }]);
		});

		it("should reconcile an existing git checkout to its update target when installing without a ref", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0" }),
				"notes.txt": "one",
			});
			clonedCheckout(gitDir(), remote);
			const latest = commit(remote, { "notes.txt": "two" }, "second");
			writeFileSync(gitDir("stray.txt"), "left over");
			managerWith();

			await packageManager.install("git:github.com/user/repo");

			expect(git(gitDir(), "rev-parse", "HEAD")).toBe(latest);
			expect(readFileSync(gitDir("notes.txt"), "utf-8")).toBe("two");
			expect(existsSync(gitDir("stray.txt"))).toBe(false);
			expect(existsSync(updateMarkerPath(gitDir()))).toBe(false);
		});

		it("should prefer the package manager after a separator over the outer executable", () => {
			settingsManager = SettingsManager.inMemory(
				{ npmCommand: ["npm", "exec", "--", "pnpm"] },
				{ projectTrusted: true },
			);
			packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });

			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			expect(managerWithInternals.getPackageManagerName()).toBe("pnpm");
			expect(managerWithInternals.getGitDependencyInstallArgs()).toEqual(PNPM_GIT_INSTALL);
		});

		it("should detect pnpm through a corepack wrapper without a separator", async () => {
			createRemote();
			managerWith({ npmCommand: ["corepack", "pnpm"] });

			await packageManager.install("git:github.com/user/repo");

			expect(readFileSync(join(agentDir, "git", ".gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
			expect(existsSync(gitDir("package.json"))).toBe(true);
			expect(calls("corepack")).toEqual([
				{ tool: "corepack", args: ["pnpm", ...PNPM_GIT_INSTALL], cwd: realpathSync(gitDir()) },
			]);
		});

		it("should disable peer installation for git package dependencies with bun", async () => {
			createRemote();
			managerWith({ npmCommand: ["bun"] });

			await packageManager.install("git:github.com/user/repo");

			expect(readFileSync(join(agentDir, "git", ".gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
			expect(existsSync(gitDir("package.json"))).toBe(true);
			expect(calls("bun")).toEqual([
				{
					tool: "bun",
					args: ["install", "--omit=dev", "--omit=peer", "--ignore-scripts"],
					cwd: realpathSync(gitDir()),
				},
			]);
		});

		it("should update git package dependencies without auto-installing peers", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0" }),
				"notes.txt": "one",
			});
			clonedCheckout(projectGitDir(), remote);
			const latest = commit(remote, { "notes.txt": "two" }, "second");
			managerWith();
			settingsManager.setProjectPackages(["git:github.com/user/repo"]);

			await packageManager.update("git:github.com/user/repo");

			expect(git(projectGitDir(), "rev-parse", "HEAD")).toBe(latest);
			expect(existsSync(updateMarkerPath(projectGitDir()))).toBe(false);
			expect(calls("npm")).toEqual([{ tool: "npm", args: NPM_GIT_INSTALL, cwd: realpathSync(projectGitDir()) }]);
		});

		it("should repair missing git package dependencies when the checkout is already current", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }),
			});
			clonedCheckout(gitDir(), remote);
			writeFileSync(gitDir("stray.txt"), "untracked, so a clean would remove it");
			managerWith();
			settingsManager.setPackages(["git:github.com/user/repo"]);

			await packageManager.update("git:github.com/user/repo");

			// Already current: no update started, no marker, nothing cleaned; only the missing dependencies installed.
			expect(existsSync(updateMarkerPath(gitDir()))).toBe(false);
			expect(existsSync(gitDir("stray.txt"))).toBe(true);
			expect(calls("git").some((entry) => entry.args[0] === "clean")).toBe(false);
			expect(calls("npm")).toEqual([{ tool: "npm", args: NPM_GIT_INSTALL, cwd: realpathSync(gitDir()) }]);
		});

		it("should repair deleted git package dependencies when cleaning fails", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }),
				"notes.txt": "one",
			});
			clonedCheckout(gitDir(), remote);
			commit(remote, { "notes.txt": "two" }, "second");
			process.env.PM_GIT_FAIL_BEFORE = "clean";
			managerWith();
			settingsManager.setPackages(["git:github.com/user/repo"]);

			await expect(packageManager.update("git:github.com/user/repo")).rejects.toThrow(
				"git clean -fdx failed with code 1",
			);

			// The failed update stays marked incomplete so the next run reconciles it.
			expect(existsSync(updateMarkerPath(gitDir()))).toBe(true);
			expect(calls("npm")).toEqual([{ tool: "npm", args: NPM_GIT_INSTALL, cwd: realpathSync(gitDir()) }]);
		});

		it("should disable peer installation through wrapped pnpm when updating git dependencies", async () => {
			const remote = createRemote({
				"package.json": JSON.stringify({ name: "repo", version: "1.0.0" }),
				"notes.txt": "one",
			});
			clonedCheckout(projectGitDir(), remote);
			commit(remote, { "notes.txt": "two" }, "second");
			managerWith({ npmCommand: ["mise", "exec", "node@20", "--", "pnpm"] });
			settingsManager.setProjectPackages(["git:github.com/user/repo"]);

			await packageManager.update("git:github.com/user/repo");

			expect(existsSync(updateMarkerPath(projectGitDir()))).toBe(false);
			expect(calls("mise")).toEqual([
				{
					tool: "mise",
					args: ["exec", "node@20", "--", "pnpm", ...PNPM_GIT_INSTALL],
					cwd: realpathSync(projectGitDir()),
				},
			]);
		});

		it("should use npmCommand argv for npm root lookup and invalidate cached root when npmCommand changes", () => {
			const pm = managerWith({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] });
			const root20 = join(tempDir, "node20", "lib", "node_modules");
			mkdirSync(join(root20, "@scope", "pkg"), { recursive: true });

			expect(pm.getInstalledPath("npm:@scope/pkg", "user")).toBe(join(root20, "@scope", "pkg"));
			expect(calls("mise").map((entry) => entry.args)).toEqual([["exec", "node@20", "--", "npm", "root", "-g"]]);

			settingsManager.setNpmCommand(["mise", "exec", "node@22", "--", "npm"]);

			expect(pm.getInstalledPath("npm:@scope/pkg", "user")).toBeUndefined();
			expect(calls("mise").map((entry) => entry.args)).toEqual([
				["exec", "node@20", "--", "npm", "root", "-g"],
				["exec", "node@22", "--", "npm", "root", "-g"],
			]);
		});

		/** Install of a package makes its folder under the prefix the call names, as the real tool would. */
		const materializeScript = (name: string, entry = "extensions/index.ts") => `
if (args[0] === "install") {
	const prefix = args[args.indexOf("--prefix") + 1];
	const dir = require("node:path").join(prefix, "node_modules", ${JSON.stringify(name)});
	fs.mkdirSync(require("node:path").dirname(require("node:path").join(dir, ${JSON.stringify(entry)})), { recursive: true });
	fs.writeFileSync(require("node:path").join(dir, "package.json"), JSON.stringify({ name: ${JSON.stringify(name)}, version: "1.0.0" }));
	fs.writeFileSync(require("node:path").join(dir, ${JSON.stringify(entry)}), "export default function() {};");
}`;
		/** An `npm view` answer table: spec (as passed to view) → stdout; a spec without an entry fails like an unreachable registry. */
		const registry = (table: Record<string, string>, extra = "") => `
${extra}
if (args[0] === "view") {
	const answer = ${JSON.stringify(table)}[args[1]];
	if (answer === undefined) { console.error("registry unavailable"); process.exit(1); }
	console.log(answer);
}`;
		const withScript = (tool: string, code: string) => {
			process.env[`PM_SCRIPT_${tool}`] = code;
		};
		const installedNpm = (root: string, name: string, version: string) => {
			const dir = join(root, "node_modules", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
			return dir;
		};
		/** The most calls of one tool (and subcommand) that were running at the same time. */
		const maxOverlap = (tool: string, first: string): number => {
			const spans = (
				existsSync(`${logFile}.spans`) ? readFileSync(`${logFile}.spans`, "utf-8").split("\n").filter(Boolean) : []
			)
				.map((line) => JSON.parse(line) as { tool: string; args: string[]; start: number; end: number })
				.filter((span) => span.tool === tool && span.args[0] === first);
			return Math.max(0, ...spans.map((a) => spans.filter((b) => b.start < a.end && a.start < b.end).length));
		};
		const viewArgs = (spec: string) => ["view", spec, "version", "--json"];

		it("should resolve wrapped pnpm global package paths from pnpm list output", () => {
			const pm = managerWith({ npmCommand: ["mise", "exec", "node@20", "--", "pnpm"] });
			const pnpmRoot = join(tempDir, "pnpm", "global", "v11");
			const packagePath = join(pnpmRoot, "20-hash", "node_modules", "pnpm-pkg");
			mkdirSync(packagePath, { recursive: true });
			withScript(
				"mise",
				`if (args.join(" ") === "exec node@20 -- pnpm list -g --depth 0 --json") console.log(JSON.stringify([{ path: ${JSON.stringify(pnpmRoot)}, dependencies: { "pnpm-pkg": { path: ${JSON.stringify(packagePath)} } } }]));
else process.exit(1);`,
			);

			expect(pm.getInstalledPath("npm:pnpm-pkg", "user")).toBe(packagePath);
		});

		it("should ignore malformed legacy pnpm global package lists", () => {
			const pm = managerWith({ npmCommand: ["pnpm"] });
			withScript("pnpm", `console.log("not json");`);

			expect(pm.getInstalledPath("npm:pnpm-pkg", "user")).toBeUndefined();
		});

		it("should emit progress events on install attempt", async () => {
			process.env.PM_FAIL = "npm";
			const events: ProgressEvent[] = [];
			managerWith().setProgressCallback((event) => events.push(event));

			await expect(packageManager.install("npm:nonexistent-package@1.0.0")).rejects.toThrow(
				/npm install .* failed with code 1/,
			);

			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
			expect(events.some((e) => e.type === "error")).toBe(true);
		});

		it("should update npm range packages using the configured spec", async () => {
			const root = join(tempDir, ".octocode", "npm");
			installedNpm(root, "example", "1.0.0");
			managerWith();
			settingsManager.setProjectPackages(["npm:example@^1.0.0"]);
			withScript("npm", registry({ "example@^1.0.0": '["1.0.0","1.2.0"]' }));
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			await packageManager.update("npm:example");

			expectManagedNpmProject(root);
			expect(events).toEqual([
				{ type: "start", action: "update", source: "npm:example@^1.0.0", message: "Updating npm:example@^1.0.0..." },
				{ type: "complete", action: "update", source: "npm:example@^1.0.0" },
			]);
			expect(calls("npm")).toEqual([
				{ tool: "npm", args: viewArgs("example@^1.0.0"), cwd: realpathSync(tempDir) },
				{
					tool: "npm",
					args: ["install", "example@^1.0.0", "--prefix", root, "--legacy-peer-deps", "--ignore-scripts"],
					cwd: realpathSync(process.cwd()),
				},
			]);
		});

		it("should skip project npm update when installed version matches latest", async () => {
			const root = join(tempDir, ".octocode", "npm");
			const installedPath = installedNpm(root, "example", "1.3.1");
			managerWith();
			settingsManager.setProjectPackages(["npm:example@^1.0.0"]);
			withScript("npm", registry({ "example@^1.0.0": '["1.0.0","1.3.1","1.0.2"]' }));
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			await packageManager.update("npm:example");

			// Nothing was installed or scaffolded and no update progress was reported.
			expect(events).toEqual([]);
			expect(existsSync(join(root, "package.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(installedPath, "package.json"), "utf-8")).version).toBe("1.3.1");
			expect(calls("npm").map((entry) => entry.args)).toEqual([viewArgs("example@^1.0.0")]);
		});

		it("should skip npm updates when the installed version is newer than the registry version", async () => {
			const root = join(tempDir, ".octocode", "npm");
			const installedPath = installedNpm(root, "example", "2.0.0");
			managerWith();
			settingsManager.setProjectPackages(["npm:example"]);
			withScript("npm", registry({ example: '"1.9.0"' }));
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			await packageManager.update("npm:example");

			expect(events).toEqual([]);
			expect(existsSync(join(root, "package.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(installedPath, "package.json"), "utf-8")).version).toBe("2.0.0");
			expect(calls("npm").map((entry) => entry.args)).toEqual([viewArgs("example")]);
		});

		it("should migrate legacy user npm installs into the managed npm root during update", async () => {
			const legacyRoot = join(tempDir, "legacy-global", "node_modules");
			const legacyPath = join(legacyRoot, "legacy-pkg");
			const managedPath = join(agentDir, "npm", "node_modules", "legacy-pkg");
			mkdirSync(legacyPath, { recursive: true });
			writeFileSync(join(legacyPath, "package.json"), JSON.stringify({ name: "legacy-pkg", version: "1.0.0" }));
			const pm = managerWith();
			settingsManager.setPackages(["npm:legacy-pkg"]);
			withScript(
				"npm",
				`if (args[0] === "root" && args.includes("-g")) console.log(${JSON.stringify(legacyRoot)});${materializeScript("legacy-pkg", "package.json")}`,
			);

			expect(pm.getInstalledPath("npm:legacy-pkg", "user")).toBe(legacyPath);

			await pm.update("npm:legacy-pkg");

			const subcommands = calls("npm").map((entry) => entry.args[0]);
			expect(subcommands).not.toContain("view");
			expect(subcommands.filter((each) => each === "install")).toHaveLength(1);
			expect(calls("npm").find((entry) => entry.args[0] === "install")?.args).toEqual([
				"install",
				"legacy-pkg@latest",
				"--prefix",
				join(agentDir, "npm"),
				"--legacy-peer-deps",
				"--ignore-scripts",
			]);
			expect(pm.getInstalledPath("npm:legacy-pkg", "user")).toBe(managedPath);
		});

		it("should batch npm updates per scope and run git updates in parallel while skipping pinned npm and current packages", async () => {
			const userRoot = join(agentDir, "npm");
			const projectRoot = join(tempDir, ".octocode", "npm");
			for (const name of ["user-old", "user-current", "user-unknown"]) installedNpm(userRoot, name, "1.0.0");
			for (const name of ["project-old", "project-current"]) installedNpm(projectRoot, name, "1.0.0");
			// Real checkouts for the git sources; the pinned one sits at its tag.
			const remoteA = createRemote({ "a.txt": "a" }, "example/user-repo-a");
			const remoteB = createRemote({ "a.txt": "b" }, "example/user-repo-b");
			const remoteP = createRemote({ "a.txt": "p" }, "example/project-repo-a");
			const remotePinned = createRemote({ "a.txt": "v1" }, "example/user-repo-pinned");
			git(remotePinned, "tag", "v1");
			const checkoutOf = (root: string, name: string) => join(root, "git", "github.com", "example", name);
			const checkouts = [
				[agentDir, "user-repo-a", remoteA],
				[agentDir, "user-repo-b", remoteB],
				[join(tempDir, ".octocode"), "project-repo-a", remoteP],
				[agentDir, "user-repo-pinned", remotePinned],
			] as const;
			for (const [root, name, remote] of checkouts) clonedCheckout(checkoutOf(root, name), remote);
			const pm = managerWith();
			settingsManager.setPackages([
				"npm:user-old",
				"npm:user-current",
				"npm:user-unknown",
				"npm:user-pinned@1.0.0",
				"git:github.com/example/user-repo-a",
				"git:github.com/example/user-repo-b",
				"git:github.com/example/user-repo-pinned@v1",
			]);
			settingsManager.setProjectPackages([
				"npm:project-old",
				"npm:project-current",
				"npm:project-missing",
				"git:github.com/example/project-repo-a",
			]);
			withScript(
				"npm",
				registry({
					"user-old": '"2.0.0"',
					"project-old": '"2.0.0"',
					"user-current": '"1.0.0"',
					"project-current": '"1.0.0"',
				}),
			);
			process.env.PM_DELAY_npm = "150";
			process.env.PM_GIT_DELAY_FETCH = "250";

			await pm.update();

			// One registry lookup per installed unpinned package; the missing and pinned ones are not looked up.
			expect(
				calls("npm")
					.filter((entry) => entry.args[0] === "view")
					.map((entry) => entry.args[1])
					.sort(),
			).toEqual(["project-current", "project-old", "user-current", "user-old", "user-unknown"]);
			// Installs are batched per scope: out-of-date and unknown packages together, current and pinned ones left out.
			const installs = calls("npm")
				.filter((entry) => entry.args[0] === "install")
				.map((entry) => entry.args)
				.sort((a, b) => a[1].localeCompare(b[1]));
			expect(installs).toEqual([
				[
					"install",
					"project-old@latest",
					"project-missing@latest",
					"--prefix",
					projectRoot,
					"--legacy-peer-deps",
					"--ignore-scripts",
				],
				[
					"install",
					"user-old@latest",
					"user-unknown@latest",
					"--prefix",
					userRoot,
					"--legacy-peer-deps",
					"--ignore-scripts",
				],
			]);
			// Each configured git checkout, the pinned one included, was refreshed once.
			const fetched = calls("git")
				.filter((entry) => entry.args[0] === "fetch")
				.map((entry) => entry.cwd)
				.sort();
			expect(fetched).toEqual(checkouts.map(([root, name]) => realpathSync(checkoutOf(root, name))).sort());
			expect(maxOverlap("npm", "install")).toBeGreaterThan(1);
			expect(maxOverlap("git", "fetch")).toBeGreaterThan(1);
		});

		it("should reinstall pinned npm packages when installed version does not match", async () => {
			const root = join(tempDir, ".octocode", "npm");
			installedNpm(root, "example", "1.0.0");
			managerWith();
			settingsManager.setProjectPackages(["npm:example@2.0.0"]);

			await packageManager.resolve();

			expect(calls("npm").map((entry) => entry.args)).toEqual([
				["install", "example@2.0.0", "--prefix", root, "--legacy-peer-deps", "--ignore-scripts"],
			]);
		});

		it("should not check package updates when offline", async () => {
			process.env.OCTOCODE_OFFLINE = "1";
			managerWith();

			expect(await packageManager.checkForAvailableUpdates()).toEqual([]);
			expect(calls()).toEqual([]);
		});

		it("should report updates for installed unpinned npm packages", async () => {
			installedNpm(join(tempDir, ".octocode", "npm"), "example", "1.0.0");
			managerWith();
			settingsManager.setProjectPackages(["npm:example"]);
			withScript("npm", registry({ example: '"1.2.3"' }));

			expect(await packageManager.checkForAvailableUpdates()).toEqual([
				{ source: "npm:example", displayName: "example", type: "npm", scope: "project" },
			]);
		});

		it("should not report npm updates when the installed version is newer than the registry version", async () => {
			installedNpm(join(tempDir, ".octocode", "npm"), "example", "2.0.0");
			managerWith();
			settingsManager.setProjectPackages(["npm:example"]);
			withScript("npm", registry({ example: '"1.9.0"' }));

			expect(await packageManager.checkForAvailableUpdates()).toEqual([]);
		});

		it("should skip pinned packages when checking for updates", async () => {
			installedNpm(join(tempDir, ".octocode", "npm"), "example", "1.0.0");
			managerWith();
			const internals = packageManager as unknown as PackageManagerInternals;
			const parsedGitSource = internals.parseSource("git:github.com/example/repo@v1");
			if (parsedGitSource.type !== "git") throw new Error("Expected a git source");
			mkdirSync(internals.getGitInstallPath(parsedGitSource, "project"), { recursive: true });
			settingsManager.setProjectPackages(["npm:example@1.0.0", "git:github.com/example/repo@v1"]);

			expect(await packageManager.checkForAvailableUpdates()).toEqual([]);
			expect(calls()).toEqual([]);
		});

		it("should use npm view to fetch latest version", async () => {
			managerWith();
			withScript("npm", registry({ example: '"1.2.3"' }));

			const latest = await (
				packageManager as unknown as { getLatestNpmVersion(name: string): Promise<string | undefined> }
			).getLatestNpmVersion("example");

			expect(latest).toBe("1.2.3");
			expect(calls("npm")).toEqual([{ tool: "npm", args: viewArgs("example"), cwd: realpathSync(tempDir) }]);
		});

		it("should use npmCommand argv for npm update checks", async () => {
			managerWith({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] });
			withScript("mise", `if (args.includes("view")) console.log('"1.2.3"');`);

			const latest = await (
				packageManager as unknown as { getLatestNpmVersion(name: string): Promise<string | undefined> }
			).getLatestNpmVersion("@scope/pkg");

			expect(latest).toBe("1.2.3");
			expect(calls("mise")).toEqual([
				{ tool: "mise", args: ["exec", "node@20", "--", "npm", ...viewArgs("@scope/pkg")], cwd: realpathSync(tempDir) },
			]);
		});

		it("should wait for close before resolving captured stdout", async () => {
			// A child that writes more than a pipe buffer and then ends: everything it wrote must be in the result.
			const internals = packageManager as unknown as {
				runCommandCapture(command: string, args: string[]): Promise<string>;
			};
			const output = await internals.runCommandCapture(process.execPath, [
				"-e",
				"process.stdout.write('x'.repeat(2_000_000) + 'END')",
			]);

			expect(output.length).toBe(2_000_003);
			expect(output.endsWith("END")).toBe(true);
		});

		it("should recognize github URLs without git: prefix", async () => {
			const source = "https://github.com/nonexistent/repo";
			managerWith();
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			// No such repository: the real clone fails.
			await expect(packageManager.install(source)).rejects.toThrow(
				/git clone https:\/\/github\.com\/nonexistent\/repo .* failed with code/,
			);

			expect(calls("git")[0]?.args.slice(0, 2)).toEqual(["clone", source]);
			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
		});
	});

	describe("source parsing", () => {
		it("should parse package source types from docs examples", () => {
			const parseNpm = (source: string) => {
				const parsed = (packageManager as any).parseSource(source);
				if (parsed.type !== "npm") {
					throw new Error(`Expected npm source: ${source}`);
				}
				return parsed;
			};

			expect(parseNpm("npm:@scope/pkg@1.2.3").pinned).toBe(true);
			expect(parseNpm("npm:@scope/pkg@^1.2.3").pinned).toBe(false);
			expect(parseNpm("npm:pkg").pinned).toBe(false);

			expect((packageManager as any).parseSource("git:github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("https://github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("git:git@github.com:user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("ssh://git@github.com/user/repo@v1").type).toBe("git");

			expect((packageManager as any).parseSource("/absolute/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("./relative/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("../relative/path/to/package").type).toBe("local");
		});

		it("should never parse dot-relative paths as git", () => {
			const dotSlash = (packageManager as any).parseSource("./packages/agent-timers");
			expect(dotSlash.type).toBe("local");
			expect(dotSlash.path).toBe("./packages/agent-timers");

			const dotDotSlash = (packageManager as any).parseSource("../packages/agent-timers");
			expect(dotDotSlash.type).toBe("local");
			expect(dotDotSlash.path).toBe("../packages/agent-timers");
		});
	});

	describe("git install paths", () => {
		it("should reject paths outside git install roots", () => {
			const managerWithInternals = packageManager as unknown as PackageManagerInternals;
			const traversalSource = {
				type: "git" as const,
				repo: "git@evil.example:../../victim/repo",
				host: "evil.example",
				path: "../../victim/repo",
				pinned: false,
			};

			for (const scope of ["user", "project", "temporary"] as const) {
				expect(() => managerWithInternals.getGitInstallPath(traversalSource, scope)).toThrow(
					"outside package install root",
				);
			}
		});
	});

	describe("settings source normalization", () => {
		it("should return false when adding the same git source with the same ref", () => {
			const first = packageManager.addSourceToSettings("git:github.com/user/repo@v1");
			expect(first).toBe(true);

			const second = packageManager.addSourceToSettings("git:github.com/user/repo@v1");
			expect(second).toBe(false);
			expect(settingsManager.getGlobalSettings().packages).toEqual(["git:github.com/user/repo@v1"]);
		});

		it("should update the ref when adding the same git source with a different ref", () => {
			packageManager.addSourceToSettings("git:github.com/user/repo@v1");

			const updated = packageManager.addSourceToSettings("git:github.com/user/repo@v2");
			expect(updated).toBe(true);
			expect(settingsManager.getGlobalSettings().packages).toEqual(["git:github.com/user/repo@v2"]);
		});
	});

	describe("HTTPS git URL parsing (old behavior)", () => {
		it("should parse HTTPS GitHub URLs correctly", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.pinned).toBe(false);
		});

		it("should parse HTTPS URLs with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:https://github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse HTTPS URLs with ref", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@v1.2.3");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
			expect(parsed.ref).toBe("v1.2.3");
			expect(parsed.pinned).toBe(true);
		});

		it("should parse host/path shorthand only with git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("git:github.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should treat host/path shorthand as local without git: prefix", async () => {
			const parsed = (packageManager as any).parseSource("github.com/user/repo");
			expect(parsed.type).toBe("local");
		});

		it("should parse HTTPS URLs with .git suffix", async () => {
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo.git");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("github.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse GitLab HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://gitlab.com/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("gitlab.com");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Bitbucket HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://bitbucket.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("bitbucket.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should parse Codeberg HTTPS URLs", async () => {
			const parsed = (packageManager as any).parseSource("https://codeberg.org/user/repo");
			expect(parsed.type).toBe("git");
			expect(parsed.host).toBe("codeberg.org");
			expect(parsed.path).toBe("user/repo");
		});

		it("should generate correct package identity for protocol and git:-prefixed URLs", async () => {
			const identity1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const identity2 = (packageManager as any).getPackageIdentity("https://github.com/user/repo@v1.0.0");
			const identity3 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const identity4 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			// All should have the same identity (normalized)
			expect(identity1).toBe("git:github.com/user/repo");
			expect(identity2).toBe("git:github.com/user/repo");
			expect(identity3).toBe("git:github.com/user/repo");
			expect(identity4).toBe("git:github.com/user/repo");
		});

		it("should handle HTTPS URLs with refs in resolve", async () => {
			// This tests that the ref is properly extracted and stored
			const parsed = (packageManager as any).parseSource("https://github.com/user/repo@main");
			expect(parsed.ref).toBe("main");
			expect(parsed.pinned).toBe(true);

			const parsed2 = (packageManager as any).parseSource("https://github.com/user/repo@feature/branch");
			expect(parsed2.ref).toBe("feature/branch");
		});
	});

	describe("pattern filtering in top-level arrays", () => {
		it("should expand ~ in exclusion and exact patterns", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const skillsDir = join(tempDir, "extra", "skills");
				for (const name of ["keep", "glob-excluded", "exact-excluded"]) {
					mkdirSync(join(skillsDir, name), { recursive: true });
					writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
				}

				settingsManager.setSkillPaths(["~/extra/skills", "!~/extra/skills/glob-*", "-~/extra/skills/exact-excluded"]);

				const result = await packageManager.resolve();
				expect(result.skills.some((r) => isEnabled(r, "keep/SKILL.md"))).toBe(true);
				expect(result.skills.some((r) => isDisabled(r, "glob-excluded/SKILL.md"))).toBe(true);
				expect(result.skills.some((r) => isDisabled(r, "exact-excluded/SKILL.md"))).toBe(true);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should filter themes with glob patterns", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "dark.json"), "{}");
			writeFileSync(join(themesDir, "light.json"), "{}");
			writeFileSync(join(themesDir, "funky.json"), "{}");

			settingsManager.setThemePaths(["themes", "!funky.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "dark.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "light.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "funky.json"))).toBe(true);
		});

		it("should filter prompts with exclusion pattern", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review code");
			writeFileSync(join(promptsDir, "explain.md"), "Explain code");

			settingsManager.setPromptTemplatePaths(["prompts", "!explain.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => isEnabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
		});

		it("should filter skills with exclusion pattern", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(join(skillsDir, "good-skill"), { recursive: true });
			mkdirSync(join(skillsDir, "bad-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(join(skillsDir, "bad-skill", "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills", "!**/bad-skill"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => isDisabled(r, "bad-skill", "includes"))).toBe(true);
		});
	});

	describe("pattern filtering in pi manifest", () => {
		it("should support glob patterns in manifest skills", async () => {
			const pkgDir = join(tempDir, "skill-manifest-pkg");
			mkdirSync(join(pkgDir, "skills/good-skill"), { recursive: true });
			mkdirSync(join(pkgDir, "skills/bad-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills/good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "skills/bad-skill", "SKILL.md"),
				"---\nname: bad-skill\ndescription: Bad\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "skill-manifest-pkg",
					octocode: {
						skills: ["skills", "!**/bad-skill"],
					},
				}),
			);

			const result = await packageManager.resolveSources([pkgDir]);
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.skills.some((r) => r.path.includes("bad-skill"))).toBe(false);
		});

		it("should expand positive glob manifest entries before collecting skills", async () => {
			const pkgDir = join(tempDir, "skill-manifest-glob-pkg");
			mkdirSync(join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown"), { recursive: true });
			mkdirSync(join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown", "SKILL.md"),
				"---\nname: pdf-to-markdown\ndescription: PDF to Markdown\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api", "SKILL.md"),
				"---\nname: document-processor-api\ndescription: DWS\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "skill-manifest-glob-pkg",
					octocode: {
						skills: ["./plugins/*/skills"],
					},
				}),
			);

			const result = await packageManager.resolveSources([pkgDir]);
			expect(result.skills.some((r) => isEnabled(r, "pdf-to-markdown", "includes"))).toBe(true);
			expect(result.skills.some((r) => isEnabled(r, "document-processor-api", "includes"))).toBe(true);
		});
	});

	describe("force-include patterns", () => {
		it("should force-include themes", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "dark.json"), "{}");
			writeFileSync(join(themesDir, "light.json"), "{}");
			writeFileSync(join(themesDir, "special.json"), "{}");

			settingsManager.setThemePaths(["themes", "!themes/*.json", "+themes/special.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isDisabled(r, "dark.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "light.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "special.json"))).toBe(true);
		});

		it("should force-include prompts", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review");
			writeFileSync(join(promptsDir, "explain.md"), "Explain");
			writeFileSync(join(promptsDir, "debug.md"), "Debug");

			settingsManager.setPromptTemplatePaths(["prompts", "!prompts/*.md", "+prompts/debug.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => isDisabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
			expect(result.prompts.some((r) => isEnabled(r, "debug.md"))).toBe(true);
		});
	});

	describe("package deduplication", () => {
		it("should dedupe SSH and HTTPS URLs for same repo", async () => {
			// Same repository, different URL formats
			const httpsUrl = "https://github.com/user/repo";
			const sshUrl = "git:git@github.com:user/repo";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			// Both should resolve to the same identity
			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH and HTTPS with refs", async () => {
			const httpsUrl = "https://github.com/user/repo@v1.0.0";
			const sshUrl = "git:git@github.com:user/repo@v1.0.0";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			// Identity should ignore ref (version)
			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH URL with ssh:// protocol and git@ format", async () => {
			const sshProtocol = "ssh://git@github.com/user/repo";
			const gitAt = "git:git@github.com:user/repo";

			const sshProtocolIdentity = (packageManager as any).getPackageIdentity(sshProtocol);
			const gitAtIdentity = (packageManager as any).getPackageIdentity(gitAt);

			// Both SSH formats should resolve to same identity
			expect(sshProtocolIdentity).toBe("git:github.com/user/repo");
			expect(gitAtIdentity).toBe("git:github.com/user/repo");
			expect(sshProtocolIdentity).toBe(gitAtIdentity);
		});

		it("should dedupe all supported URL formats for same repo", async () => {
			const urls = [
				"https://github.com/user/repo",
				"https://github.com/user/repo.git",
				"ssh://git@github.com/user/repo",
				"git:https://github.com/user/repo",
				"git:github.com/user/repo",
				"git:git@github.com:user/repo",
				"git:git@github.com:user/repo.git",
			];

			const identities = urls.map((url) => (packageManager as any).getPackageIdentity(url));

			// All should produce the same identity
			const uniqueIdentities = [...new Set(identities)];
			expect(uniqueIdentities.length).toBe(1);
			expect(uniqueIdentities[0]).toBe("git:github.com/user/repo");
		});

		it("should keep different repos separate (HTTPS vs SSH)", async () => {
			const repo1Https = "https://github.com/user/repo1";
			const repo2Ssh = "git:git@github.com:user/repo2";

			const id1 = (packageManager as any).getPackageIdentity(repo1Https);
			const id2 = (packageManager as any).getPackageIdentity(repo2Ssh);

			// Different repos should have different identities
			expect(id1).toBe("git:github.com/user/repo1");
			expect(id2).toBe("git:github.com/user/repo2");
			expect(id1).not.toBe(id2);
		});
	});

	describe("offline mode and network timeouts", () => {
		it("should suggest npm source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["npm:example"]);

			await expect(packageManager.update("example")).rejects.toThrow(
				"No matching package found for example. Did you mean npm:example?",
			);
		});

		it("should suggest git source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["git:github.com/example/repo"]);

			await expect(packageManager.update("github.com/example/repo")).rejects.toThrow(
				"No matching package found for github.com/example/repo. Did you mean git:github.com/example/repo?",
			);
		});
	});
});
