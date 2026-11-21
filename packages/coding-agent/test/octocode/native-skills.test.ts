import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { asSetup } from "./fake-host.ts";
import { adoptSkillResourceSnapshot, captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { bundledSkillDirs, registerSkills } from "../../src/octocode/skills.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

describe("skills the application ships", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "native-skills-"));
		fs.mkdirSync(path.join(root, "project"));
		fs.mkdirSync(path.join(root, "agent"));
		vi.stubEnv("HOME", root);
		vi.stubEnv("OCTOCODE_OFFLINE", "1");
		vi.stubEnv("OCTOCODE_SUBAGENT", "");
		vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** What a root session does at startup: the native extension answers `resources_discover`, the loader extends itself. */
	const loadRoot = async () => {
		const loader = new DefaultResourceLoader({
			cwd: path.join(root, "project"),
			agentDir: path.join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			nativeFeatures: nativeFeatureSet(),
			disabledFeatures: ["mcp"],
		});
		await loader.reload();
		let handler: ((event: unknown, ctx: unknown) => Promise<{ skillPaths: string[] }>) | undefined;
		registerSkills(
			asSetup({
				on: (_event: string, listener: typeof handler) => (handler = listener),
			}),
		);
		const { skillPaths } = (await handler?.(
			{ type: "resources_discover", cwd: path.join(root, "project"), reason: "startup" },
			{ hasUI: false, ui: {}, isProjectTrusted: () => true },
		)) ?? { skillPaths: [] };
		loader.extendResources({
			skillPaths: skillPaths.map((file) => ({
				path: file,
				metadata: { source: "extension:skills", scope: "temporary", origin: "top-level" },
			})),
		});
		return loader;
	};

	it("holds the core skills as valid skills, and octocode-context-optimization covers skill descriptions only", () => {
		const { skills, diagnostics } = loadSkills({
			cwd: path.join(root, "project"),
			agentDir: path.join(root, "agent"),
			skillPaths: [getNativeSkillsDir()],
			includeDefaults: false,
		});
		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name).sort()).toEqual([
			"octocode-backlog",
			"octocode-clasify",
			"octocode-code-review",
			"octocode-context-optimization",
			"octocode-critical-thinking",
			"octocode-debugging",
			"octocode-github-research",
			"octocode-local-research",
			"octocode-maintenance",
			"octocode-memory",
			"octocode-output",
			"octocode-security-review",
			"octocode-subagents",
			"octocode-visual-browsing",
			"resume-external-harness",
		]);
		// Delegation, filing items and saving memories need tools only the coordinator holds.
		expect(
			skills
				.filter((skill) => skill.audience === "coordinator")
				.map((skill) => skill.name)
				.sort(),
		).toEqual(["octocode-backlog", "octocode-maintenance", "octocode-memory", "octocode-subagents"]);
		const dir = path.join(getNativeSkillsDir(), "octocode-context-optimization");
		// Every file the skill links exists.
		const body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
		for (const [, link] of body.matchAll(/\]\(((?!https?:)[^)#]+)/g))
			expect(fs.existsSync(path.join(dir, link))).toBe(true);
		expect(fs.existsSync(path.join(dir, "scripts"))).toBe(false);
	});

	it("is discovered by a root session, even with extra skill folders turned off", async () => {
		expect(bundledSkillDirs({})).toEqual([getNativeSkillsDir()]);
		const skill = (await loadRoot())
			.getSkills()
			.skills.find((candidate) => candidate.name === "octocode-context-optimization");
		expect(skill?.filePath).toBe(path.join(getNativeSkillsDir(), "octocode-context-optimization", "SKILL.md"));
		vi.stubEnv("OCTOCODE_EXTRA_SKILLS", "0");
		expect((await loadRoot()).getSkills().skills.map((candidate) => candidate.name)).toContain(
			"octocode-context-optimization",
		);
	});

	it("is left to a subagent's inherited inventory instead of discovered again", async () => {
		const parent = await loadRoot();
		const inventory = JSON.parse(JSON.stringify(captureSkillResourceSnapshot(parent.getSkills())));
		expect(adoptSkillResourceSnapshot(inventory).skills.map((skill) => skill.name)).toContain(
			"octocode-context-optimization",
		);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		expect(bundledSkillDirs()).toEqual([]);
		const child = new DefaultResourceLoader({
			cwd: path.join(root, "project"),
			agentDir: path.join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			nativeFeatures: nativeFeatureSet(),
			noSkills: true,
		});
		await child.reload();
		expect(child.getSkills().skills.map((skill) => skill.name)).not.toContain("octocode-context-optimization");
	});

	describe("octocode-debugging scripts", () => {
		const scripts = path.join(getNativeSkillsDir(), "octocode-debugging", "scripts");
		const program = (name: string, source: string) => {
			fs.writeFileSync(path.join(root, name), source);
			return name;
		};
		const run = (script: string, args: string[]) =>
			spawnSync(process.execPath, [path.join(scripts, script), ...args], {
				cwd: root,
				encoding: "utf8",
				timeout: 30_000,
			});
		const events = (stdout: string) =>
			stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		const loop =
			"function total(xs) {\n\tlet s = 0;\n\tfor (const x of xs) {\n\t\ts += x * 2;\n\t}\n\treturn s;\n}\nconsole.log(total([1, 2, 3]));\nprocess.exitCode = 3;\n";

		it("node-break reports each conditional hit with the evaluated values, names unbound breakpoints and keeps the exit code", () => {
			const result = run("node-break.mjs", [
				"--break",
				"loop.mjs:4:x > 1",
				"--break",
				"missing.mjs:1",
				"--eval",
				"s",
				"--eval",
				"x",
				"--",
				program("loop.mjs", loop),
			]);
			expect(result.status).toBe(3);
			expect(result.stdout).toContain("12");
			expect(events(result.stdout)).toEqual([
				expect.objectContaining({ event: "hit", thread: "main", at: "total loop.mjs:4", values: { s: 2, x: 2 } }),
				expect.objectContaining({ event: "hit", at: "total loop.mjs:4", values: { s: 6, x: 3 } }),
				{ event: "unbound", break: "missing.mjs:1" },
				{ event: "exit", code: 3, signal: null, pauses: 2 },
			]);
		});

		it("node-break stops where an exception is thrown in the program, not in Node's own frames", () => {
			const source = "function ratio(o) {\n\tthrow new Error(`bad ${o.k}`);\n}\nratio({ k: 3 });\n";
			const result = run("node-break.mjs", ["--exceptions", "all", "--", program("throw.mjs", source)]);
			expect(result.status).toBe(1);
			const found = events(result.stdout);
			expect(found.filter((event) => event.event === "exception")).toEqual([
				expect.objectContaining({
					at: "ratio throw.mjs:2",
					values: { o: "Object {k: 3}" },
					stack: ["ratio throw.mjs:2", "<anonymous> throw.mjs:4"],
				}),
			]);
		});

		it("node-break prints where a hanging program is stuck and stops it at the timeout", () => {
			const result = run("node-break.mjs", [
				"--timeout",
				"1",
				"--",
				program("hang.mjs", "let i = 0;\nwhile (true) i++;\n"),
			]);
			expect(result.status).not.toBe(0);
			expect(events(result.stdout)).toEqual([
				expect.objectContaining({ event: "timeout", thread: "main", stack: [expect.stringMatching(/hang\.mjs:2$/)] }),
				expect.objectContaining({ event: "exit", signal: "SIGKILL" }),
			]);
		});

		it("profile-top ranks the hottest function of the newest CPU profile in a directory", () => {
			const source =
				"function hot(n) {\n\tlet s = 0;\n\tfor (let i = 0; i < n; i++) s += Math.sqrt(i);\n\treturn s;\n}\nconsole.log(hot(3e7) > 0);\n";
			const profiled = spawnSync(process.execPath, ["--cpu-prof", "--cpu-prof-dir=prof", program("hot.mjs", source)], {
				cwd: root,
			});
			expect(profiled.status).toBe(0);
			const result = run("profile-top.mjs", ["prof", "--top", "1", "--filter", "hot.mjs"]);
			expect(result.status).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines[1]).toMatch(/^CPU profile: \d+ ms wall/);
			expect(lines.slice(3)).toEqual([expect.stringMatching(/%\s+hot\s+hot\.mjs:1$/)]);
		});

		it("profile-top reads a heap profile as bytes, counting a recursive function's total once", () => {
			const frame = (functionName: string, lineNumber: number) => ({
				functionName,
				url: "file:///app/a.js",
				lineNumber,
			});
			const head = {
				callFrame: frame("(root)", -1),
				selfSize: 0,
				children: [
					{
						callFrame: frame("walk", 0),
						selfSize: 100,
						children: [{ callFrame: frame("walk", 0), selfSize: 300, children: [] }],
					},
				],
			};
			fs.writeFileSync(path.join(root, "a.heapprofile"), JSON.stringify({ head }));
			const result = run("profile-top.mjs", ["a.heapprofile"]);
			expect(result.stdout).toContain("Heap profile: 400 bytes sampled live");
			expect(result.stdout).toMatch(/\b400\s+100\.0%\s+400\s+100\.0%\s+walk\s+\/app\/a\.js:1/);
		});
	});
});
