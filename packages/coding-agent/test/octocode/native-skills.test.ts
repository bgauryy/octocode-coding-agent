import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { adoptSkillResourceSnapshot, captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkills } from "../../src/core/skills.ts";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { bundledSkillDirs, registerSkills } from "../../src/octocode/skills.ts";

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
			disabledFeatures: ["mcp", "llama.cpp"],
		});
		await loader.reload();
		let handler: ((event: unknown, ctx: unknown) => Promise<{ skillPaths: string[] }>) | undefined;
		registerSkills({
			on: (_event: string, listener: typeof handler) => (handler = listener),
		} as unknown as ExtensionAPI);
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

	it("holds octocode-context-optimization as a valid skill whose scripts only call the CLI", () => {
		const { skills, diagnostics } = loadSkills({
			cwd: path.join(root, "project"),
			agentDir: path.join(root, "agent"),
			skillPaths: [getNativeSkillsDir()],
			includeDefaults: false,
		});
		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["octocode-context-optimization"]);
		const dir = path.join(getNativeSkillsDir(), "octocode-context-optimization");
		expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("octocode-agentic-prompts");
		for (const script of fs.readdirSync(path.join(dir, "scripts"))) {
			const source = fs.readFileSync(path.join(dir, "scripts", script), "utf8");
			expect(source).not.toMatch(/packages\/mcp|packages["',\s]+join|compact\/index\.ts/);
		}
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
			noSkills: true,
		});
		await child.reload();
		expect(child.getSkills().skills.map((skill) => skill.name)).not.toContain("octocode-context-optimization");
	});

	describe("scripts", () => {
		const scripts = path.join(getNativeSkillsDir(), "octocode-context-optimization", "scripts");
		/** An executable standing in for `octocode`: it records its arguments and writes the --out file it is given. */
		const fakeCli = () => {
			const log = path.join(root, "calls.jsonl");
			const bin = path.join(root, "fake-octocode.mjs");
			fs.writeFileSync(
				bin,
				`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const out = args.indexOf("--out");
if (out >= 0) writeFileSync(args[out + 1], "{}");
if (args.includes("--plain")) console.log("// plain file");
process.exit(args.includes("fail") ? 3 : 0);
`,
				{ mode: 0o755 },
			);
			return {
				bin,
				calls: () =>
					fs
						.readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
			};
		};
		const run = (script: string, args: string[], bin: string) =>
			spawnSync(process.execPath, [path.join(scripts, script), ...args], {
				encoding: "utf8",
				env: { ...process.env, OCTOCODE_BIN: bin },
			});

		it("generate saves the catalog and the plain file through `mcp compact catalog` and `show --plain`", () => {
			const { bin, calls } = fakeCli();
			const work = path.join(root, "work");
			const result = run("generate.mjs", ["demo", "--work", work], bin);
			expect(result.status).toBe(0);
			expect(calls()).toEqual([
				["mcp", "compact", "catalog", "demo", "--out", path.join(work, "demo.catalog.json")],
				["mcp", "compact", "show", "demo", "--plain", "--catalog", path.join(work, "demo.catalog.json")],
			]);
			expect(fs.readFileSync(path.join(work, "demo.plain.ts"), "utf8")).toBe("// plain file\n");
		});

		it("check and apply use the saved catalog and pass the exit status through", () => {
			const { bin, calls } = fakeCli();
			const work = path.join(root, "work");
			fs.mkdirSync(work);
			fs.writeFileSync(path.join(work, "demo.catalog.json"), "{}");
			expect(run("check.mjs", ["demo", "--overrides", "o.json", "--work", work], bin).status).toBe(0);
			expect(
				run("apply.mjs", ["demo", "--overrides", "o.json", "--optimized-by", "m", "--work", work], bin).status,
			).toBe(0);
			expect(calls()).toEqual([
				["mcp", "compact", "check", "demo", "--overrides", "o.json", "--catalog", path.join(work, "demo.catalog.json")],
				[
					"mcp",
					"compact",
					"apply",
					"demo",
					"--overrides",
					"o.json",
					"--optimized-by",
					"m",
					"--catalog",
					path.join(work, "demo.catalog.json"),
				],
			]);
			expect(run("check.mjs", ["fail", "--overrides", "o.json", "--work", work], bin).status).toBe(3);
		});

		it("check asks the live server when no catalog was saved, and apply needs the model name", () => {
			const { bin, calls } = fakeCli();
			expect(run("check.mjs", ["demo", "--overrides", "o.json", "--work", path.join(root, "empty")], bin).status).toBe(
				0,
			);
			expect(calls()).toEqual([["mcp", "compact", "check", "demo", "--overrides", "o.json"]]);
			expect(run("apply.mjs", ["demo", "--overrides", "o.json"], bin).status).toBe(1);
		});
	});
});
