import "../mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContextCommand } from "../../src/octocode/context-optimization/command.ts";
import {
	applySkillOverrides,
	readSkillsStore,
	syncSkills,
	updateSkillsStore,
	writeSkillsStore,
} from "../../src/octocode/context-optimization/skills-store.ts";
import { contextOptimizationDirs } from "../../src/octocode/shared/home.ts";

let root: string;
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-concurrency-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const source = (name: string, description = `${name} source`) => ({ name, description, file: `/${name}/SKILL.md` });

describe("concurrent skills store updates", () => {
	it("retains skills discovered by simultaneous sessions", async () => {
		await Promise.all(
			["alpha", "beta"].map((name) =>
				updateSkillsStore(root, (current) => syncSkills(current, [source(name)]).store, "record"),
			),
		);
		expect(Object.keys(readSkillsStore(root).skills).sort()).toEqual(["alpha", "beta"]);
		const view = fs.readFileSync(path.join(root, "skills.txt"), "utf8");
		expect(view).toContain("alpha source");
		expect(view).toContain("beta source");
	});

	it("preserves a rewrite and unrelated records when recording overlaps applying", async () => {
		writeSkillsStore(root, syncSkills(readSkillsStore(root), [source("alpha")]).store);
		await Promise.all([
			updateSkillsStore(root, (current) => syncSkills(current, [source("beta")]).store, "record"),
			updateSkillsStore(root, (current) => applySkillOverrides(current, { alpha: "Short alpha" })),
		]);
		expect(readSkillsStore(root).skills).toMatchObject({
			alpha: { description: "Short alpha", source: "alpha source" },
			beta: { source: "beta source" },
		});
	});

	it("refuses a rewrite when its source changes after validation", async () => {
		const agentDir = path.join(root, "agent");
		const dir = contextOptimizationDirs(root, agentDir).user;
		writeSkillsStore(dir, syncSkills(readSkillsStore(dir), [source("alpha")]).store);
		const overrides = path.join(root, "overrides.json");
		fs.writeFileSync(overrides, JSON.stringify({ skills: { alpha: "Short alpha" } }));
		const errors: string[] = [];
		let changed = false;
		const result = await runContextCommand(["apply", "--overrides", overrides], {
			agentDir,
			cwd: root,
			log: () => {
				if (changed) return;
				changed = true;
				writeSkillsStore(dir, syncSkills(readSkillsStore(dir), [source("alpha", "Changed source")]).store);
			},
			error: (line) => errors.push(line),
		});
		expect(result).toBe(1);
		expect(errors.join("\n")).toContain("alpha: its source changed");
		expect(readSkillsStore(dir).skills.alpha).toMatchObject({ source: "Changed source" });
		expect(readSkillsStore(dir).skills.alpha?.description).toBeUndefined();
	});
});
