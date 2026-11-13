import "../mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import type { Skill } from "../../src/core/skills.ts";
import { registerSkillDescriptions } from "../../src/octocode/context-optimization/skills.ts";
import {
	applySkillOverrides,
	readSkillsStore,
	syncSkills,
	writeSkillsStore,
} from "../../src/octocode/context-optimization/skills-store.ts";
import { contextOptimizationDirs } from "../../src/octocode/shared/home.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let root: string;
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-durability-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the skills store a session records", () => {
	it("is written before the first request with one flush (the store's data), and rewrites stay flushed in full", async () => {
		const agentDir = path.join(root, "agent");
		// A user-level skill: its file is outside the session's folder.
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd);
		const userDir = contextOptimizationDirs(cwd, agentDir).user;
		const handlers = new Map<string, Handler>();
		registerSkillDescriptions(
			{ on: (event: string, handler: Handler) => handlers.set(event, handler) } as unknown as ExtensionAPI,
			{ isSubagent: false, agentDir: () => agentDir },
		);
		const file = path.join(root, "skills", "a", "SKILL.md");
		const skills = [{ name: "a", description: "A source", filePath: file, baseDir: path.dirname(file) } as Skill];
		const fsync = vi.spyOn(fs, "fsyncSync");
		await handlers.get("before_agent_start")?.(
			{ systemPromptOptions: { skills } },
			{ cwd, hasUI: false, ui: { notify: () => {} } },
		);
		expect(Object.keys(readSkillsStore(userDir).skills)).toEqual(["a"]);
		expect(fsync).toHaveBeenCalledTimes(1);

		fsync.mockClear();
		writeSkillsStore(userDir, applySkillOverrides(readSkillsStore(userDir), { a: "A short" }));
		expect(readSkillsStore(userDir).skills.a?.description).toBe("A short");
		// The store and its view, each with its folder.
		expect(fsync).toHaveBeenCalledTimes(4);
		expect(syncSkills(readSkillsStore(userDir), [{ name: "a", description: "A source", file }]).dirty).toBe(false);
	});
});
