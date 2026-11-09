import "../mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatedDir, serverGeneratedDir, writeGenerated } from "../../../mcp/src/compact/store.ts";
import { getNativeSkillsDir } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import type { Skill } from "../../src/core/skills.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { runContextCommand } from "../../src/octocode/context-optimization/command.ts";
import { registerSkillDescriptions } from "../../src/octocode/context-optimization/skills.ts";
import {
	applySkillOverrides,
	checkSkillOverrides,
	effectiveDescription,
	parseSkillOverrides,
	readSkillsStore,
	syncSkills,
	writeSkillsStore,
} from "../../src/octocode/context-optimization/skills-store.ts";
import { contextOptimizationDirs } from "../../src/octocode/shared/home.ts";

const skill = (name: string, description: string, filePath: string, extra: Partial<Skill> = {}): Skill =>
	({
		name,
		description,
		filePath,
		baseDir: path.dirname(filePath),
		disableModelInvocation: false,
		...extra,
	}) as Skill;

describe("context optimization", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let userDir: string;
	let projectDir: string;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-optimization-")));
		agentDir = path.join(root, "agent");
		project = path.join(root, "repo");
		fs.mkdirSync(path.join(project, ".git"), { recursive: true });
		const dirs = contextOptimizationDirs(project, agentDir);
		userDir = dirs.user;
		projectDir = dirs.project?.dir ?? "";
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	it("keeps optimized files in the agent directory: user-level, and per project", () => {
		expect(userDir).toBe(path.join(agentDir, "context-optimization"));
		expect(projectDir).toMatch(new RegExp(`^${path.join(userDir, "projects", "repo-")}[0-9a-f]{12}$`));
		expect(contextOptimizationDirs(path.join(project, "sub"), agentDir).project?.dir).toBe(projectDir);
		const other = path.join(root, "other");
		fs.mkdirSync(path.join(other, ".git"), { recursive: true });
		expect(contextOptimizationDirs(other, agentDir).project?.dir).not.toBe(projectDir);
		expect(contextOptimizationDirs(undefined, agentDir)).toEqual({ user: userDir });
	});

	describe("skills store", () => {
		it("keeps a rewrite only for the source it was written for", () => {
			const first = syncSkills(readSkillsStore(userDir), [{ name: "a", description: "Old", file: "/a" }]);
			expect(first.changed).toEqual(["a"]);
			const optimized = applySkillOverrides(first.store, { a: "Short" }, "model-x");
			expect(effectiveDescription([optimized], "a", "Old")).toBe("Short");
			expect(optimized.skills.a?.optimizedBy?.model).toBe("model-x");
			expect(syncSkills(optimized, [{ name: "a", description: "Old", file: "/a" }])).toMatchObject({
				changed: [],
				dirty: false,
			});
			const edited = syncSkills(optimized, [{ name: "a", description: "New", file: "/a" }]);
			expect(edited.changed).toEqual(["a"]);
			expect(effectiveDescription([edited.store], "a", "New")).toBe("New");
			// A stale rewrite never reaches a changed source, even before a session records it.
			expect(effectiveDescription([optimized], "a", "New")).toBe("New");
		});

		it("reads the first store whose rewrite matches", () => {
			const store = (description: string) =>
				applySkillOverrides(syncSkills(readSkillsStore(userDir), [{ name: "a", description: "A", file: "/a" }]).store, {
					a: description,
				});
			expect(effectiveDescription([store("project"), store("user")], "a", "A")).toBe("project");
			const stale = applySkillOverrides(
				syncSkills(readSkillsStore(userDir), [{ name: "a", description: "Other", file: "/a" }]).store,
				{ a: "stale" },
			);
			expect(effectiveDescription([stale, store("user")], "a", "A")).toBe("user");
		});

		it("follows a moved file and writes a view of what agents read", () => {
			const store = syncSkills(readSkillsStore(userDir), [{ name: "a", description: "A", file: "/one" }]).store;
			const moved = syncSkills(store, [{ name: "a", description: "A", file: "/two" }]);
			expect(moved).toMatchObject({ changed: [], dirty: true });
			const written = applySkillOverrides(
				syncSkills(moved.store, [{ name: "b", description: "B source", file: "/b" }]).store,
				{ a: "A short" },
			);
			writeSkillsStore(userDir, written);
			expect(readSkillsStore(userDir)).toEqual(written);
			expect(fs.readFileSync(path.join(userDir, "skills.txt"), "utf8")).toBe("a\nA short\n\nb (source)\nB source\n");
			fs.writeFileSync(path.join(userDir, "skills.json"), "{");
			expect(readSkillsStore(userDir)).toEqual({ version: 1, skills: {} });
		});

		it("validates rewrites", () => {
			expect(parseSkillOverrides({ skill: {} })).toEqual({ error: "unknown overrides key: skill" });
			expect(parseSkillOverrides({ skills: { a: 1 } })).toEqual({
				error: '"skills" must map skill names to descriptions',
			});
			const store = syncSkills(readSkillsStore(userDir), [{ name: "a", description: "A", file: "/a" }]).store;
			expect(
				checkSkillOverrides(store, { a: "x".repeat(1025), missing: "y", empty: " " }).map(
					(problem) => problem.split(":")[0],
				),
			).toEqual(["a", "missing", "empty"]);
			expect(checkSkillOverrides(store, { a: "One.\n\nTwo." })).toEqual(["a: write one paragraph"]);
			expect(checkSkillOverrides(store, { a: "Fine." })).toEqual([]);
		});
	});

	describe("the skills listing agents read", () => {
		type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
		const userSkill = () => skill("global", "Global source", path.join(root, "home-skills", "global", "SKILL.md"));
		const projectSkill = () => skill("local", "Local source", path.join(project, ".octocode", "skills", "local.md"));
		const register = (isSubagent: boolean, cwd = project) => {
			const handlers = new Map<string, Handler>();
			registerSkillDescriptions(
				{ on: (event: string, handler: Handler) => handlers.set(event, handler) } as unknown as ExtensionAPI,
				{ isSubagent, agentDir: () => agentDir },
			);
			const notices: string[] = [];
			const ctx = { cwd, hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
			const prompt = async (skills: Skill[]) => {
				const event = { systemPromptOptions: { skills } };
				await handlers.get("before_agent_start")?.(event, ctx);
				return event.systemPromptOptions.skills.map((entry) => entry.description);
			};
			const start = () => handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
			return { prompt, start, notices };
		};

		it("records each skill in its scope, once, and shows rewrites from the next start", async () => {
			const main = register(false);
			const hidden = skill("hidden", "H", "/h/SKILL.md", { disableModelInvocation: true });
			const skills = [userSkill(), projectSkill(), hidden];
			expect(await main.prompt(skills)).toEqual(["Global source", "Local source", "H"]);
			// Contract: a skill's own description is never flagged for rewriting (user decision, 2026-11-04).
			expect(main.notices).toEqual([]);
			expect(Object.keys(readSkillsStore(userDir).skills)).toEqual(["global"]);
			expect(Object.keys(readSkillsStore(projectDir).skills)).toEqual(["local"]);

			writeSkillsStore(userDir, applySkillOverrides(readSkillsStore(userDir), { global: "Global short" }));
			writeSkillsStore(projectDir, applySkillOverrides(readSkillsStore(projectDir), { local: "Local short" }));
			// The running session keeps the text it started with, so its cached prompt does not change.
			expect(await main.prompt(skills)).toEqual(["Global source", "Local source", "H"]);
			await main.start();
			expect(await main.prompt(skills)).toEqual(["Global short", "Local short", "H"]);
			expect(main.notices).toEqual([]);
		});

		it("keeps bundled skills user-level", async () => {
			const bundled = skill("bundled", "Bundled source", path.join(getNativeSkillsDir(), "bundled", "SKILL.md"));
			const inRepo = contextOptimizationDirs(getNativeSkillsDir(), agentDir);
			await register(false, getNativeSkillsDir()).prompt([bundled]);
			expect(Object.keys(readSkillsStore(userDir).skills)).toEqual(["bundled"]);
			if (inRepo.project) expect(readSkillsStore(inRepo.project.dir).skills).toEqual({});
		});

		it("shares user-level rewrites with every project but keeps project ones in their project", async () => {
			await register(false).prompt([userSkill(), projectSkill()]);
			writeSkillsStore(userDir, applySkillOverrides(readSkillsStore(userDir), { global: "Global short" }));
			writeSkillsStore(projectDir, applySkillOverrides(readSkillsStore(projectDir), { local: "Local short" }));
			const other = path.join(root, "other");
			fs.mkdirSync(path.join(other, ".git"), { recursive: true });
			const elsewhere = register(false, other);
			const sameName = skill("local", "Local source", path.join(other, ".octocode", "skills", "local.md"));
			expect(await elsewhere.prompt([userSkill(), sameName])).toEqual(["Global short", "Local source"]);
			expect(readSkillsStore(projectDir).skills.local?.description).toBe("Local short");
		});

		it("puts the optimized descriptions into the system prompt agents receive", async () => {
			const main = register(false);
			await main.prompt([userSkill(), projectSkill()]);
			writeSkillsStore(projectDir, applySkillOverrides(readSkillsStore(projectDir), { local: "Load for local work." }));
			await main.start();
			const event = { systemPromptOptions: { skills: [userSkill(), projectSkill()] } };
			const handlers = new Map<string, Handler>();
			registerSkillDescriptions(
				{ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI,
				{ isSubagent: true, agentDir: () => agentDir },
			);
			await handlers.get("before_agent_start")?.(event, { cwd: project, hasUI: false, ui: {} });
			const prompt = buildSystemPrompt({
				cwd: project,
				selectedTools: ["skill"],
				skills: event.systemPromptOptions.skills,
			});
			expect(prompt).toContain("<description>Load for local work.</description>");
			expect(prompt).toContain("<description>Global source</description>");
			expect(prompt).not.toContain("Local source");
		});

		it("lets a subagent read both stores without writing them", async () => {
			await register(false).prompt([userSkill(), projectSkill()]);
			writeSkillsStore(projectDir, applySkillOverrides(readSkillsStore(projectDir), { local: "Local short" }));
			const child = register(true);
			const extra = skill("new", "N", "/n/SKILL.md");
			expect(await child.prompt([userSkill(), projectSkill(), extra])).toEqual(["Global source", "Local short", "N"]);
			expect(child.notices).toEqual([]);
			expect(Object.keys(readSkillsStore(userDir).skills)).toEqual(["global"]);
		});
	});

	describe("octocode context", () => {
		const run = async (...args: string[]) => {
			const out: string[] = [];
			const err: string[] = [];
			const code = await runContextCommand(args, {
				agentDir,
				cwd: project,
				log: (line) => out.push(line),
				error: (line) => err.push(line),
			});
			return { code, out: out.join("\n"), err: err.join("\n") };
		};

		it("checks, applies each rewrite in its scope, and lists both scopes", async () => {
			writeSkillsStore(
				userDir,
				syncSkills(readSkillsStore(userDir), [{ name: "a", description: "A long source", file: "/a" }]).store,
			);
			writeSkillsStore(
				projectDir,
				syncSkills(readSkillsStore(projectDir), [{ name: "p", description: "P source", file: "/p" }]).store,
			);
			const file = path.join(root, "overrides.json");
			fs.writeFileSync(file, JSON.stringify({ skills: { a: "A", missing: "M" } }));
			expect(await run("check", "--overrides", file)).toMatchObject({ code: 1 });
			expect((await run("apply", "--overrides", file)).code).toBe(1);
			expect(readSkillsStore(userDir).skills.a?.description).toBeUndefined();

			fs.writeFileSync(file, JSON.stringify({ skills: { a: "A", p: "P" } }));
			expect(await run("check", "--overrides", file)).toMatchObject({ code: 0 });
			expect((await run("apply", "--overrides", file, "--optimized-by", "m")).code).toBe(0);
			expect(readSkillsStore(userDir).skills.a).toMatchObject({ description: "A", optimizedBy: { model: "m" } });
			expect(readSkillsStore(projectDir).skills.p).toMatchObject({ description: "P" });
			expect(readSkillsStore(userDir).skills.p).toBeUndefined();

			const listed = await run("list");
			expect(listed.out).toContain("Skills: 2/2 optimized");
			expect(listed.out).toContain(`Project: ${projectDir}`);
			expect(listed.out).toContain("skill a  optimized  13 → 1");
			const json = JSON.parse((await run("list", "--json")).out) as { scopes: Array<{ scope: string }> };
			expect(json.scopes.map((scope) => scope.scope)).toEqual(["project", "user"]);
		});

		it("marks records whose skill file no longer exists as stale, and keeps the store", async () => {
			const live = path.join(root, "live", "SKILL.md");
			fs.mkdirSync(path.dirname(live), { recursive: true });
			fs.writeFileSync(live, "x");
			writeSkillsStore(
				userDir,
				syncSkills(readSkillsStore(userDir), [
					{ name: "live", description: "Live source", file: live },
					{ name: "gone", description: "Gone source", file: path.join(root, "gone", "SKILL.md") },
				]).store,
			);
			const listed = await run("list");
			expect(listed.out).toMatch(/skill gone .*stale/);
			expect(listed.out).not.toMatch(/skill live .*stale/);
			const json = JSON.parse((await run("list", "--json")).out) as {
				scopes: Array<{ skills: Array<{ name: string; stale: boolean }> }>;
			};
			expect(json.scopes.flatMap((scope) => scope.skills.map((row) => [row.name, row.stale]))).toEqual([
				["gone", true],
				["live", false],
			]);
			expect(Object.keys(readSkillsStore(userDir).skills).sort()).toEqual(["gone", "live"]);
		});

		it("marks MCP records stale when no configured server has the name, and keeps the files", async () => {
			const dir = generatedDir(agentDir);
			for (const server of ["live", "gone"])
				writeGenerated(dir, server, "text", {
					hash: "h",
					generatorVersion: 1,
					generatedAt: "2026-01-01T00:00:00.000Z",
				});
			fs.writeFileSync(
				path.join(agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { live: { command: "live-server" } } }),
			);
			expect((await run("list")).out).toMatch(/mcp gone .*stale/);
			expect((await run("list")).out).not.toMatch(/mcp live .*stale/);
			const json = JSON.parse((await run("list", "--json")).out) as {
				scopes: Array<{ scope: string; mcp: Array<{ server: string; stale: boolean }> }>;
			};
			const user = json.scopes.find((scope) => scope.scope === "user");
			expect(user?.mcp.map((row) => [row.server, row.stale])).toEqual([
				["gone", true],
				["live", false],
			]);
			expect(
				fs
					.readdirSync(dir)
					.filter((file) => file.endsWith(".json"))
					.sort(),
			).toEqual(["gone.json", "live.json"]);
		});

		it("explains an empty store and an unknown command", async () => {
			expect((await run("list")).out).toContain("No skills recorded yet");
			expect(await run("nope")).toMatchObject({ code: 1 });
			expect(await run("check")).toMatchObject({ code: 1 });
		});
	});

	describe("MCP files", () => {
		it("moves the folder earlier releases used", () => {
			const legacy = path.join(agentDir, "mcp-generated");
			fs.mkdirSync(legacy, { recursive: true });
			fs.writeFileSync(path.join(legacy, "server.json"), "{}");
			const dir = generatedDir(agentDir);
			expect(dir).toBe(path.join(userDir, "mcp"));
			expect(fs.existsSync(path.join(dir, "server.json"))).toBe(true);
			expect(fs.existsSync(legacy)).toBe(false);
		});

		it("keeps a workspace server's file in its project", () => {
			expect(serverGeneratedDir(agentDir, project, "project")).toBe(path.join(projectDir, "mcp"));
			for (const scope of ["global", "default", "extension", undefined])
				expect(serverGeneratedDir(agentDir, project, scope)).toBe(path.join(userDir, "mcp"));
		});
	});
});
