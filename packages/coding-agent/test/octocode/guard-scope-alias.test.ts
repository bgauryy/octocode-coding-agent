import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../../../db/src/api.ts";
import { loadSkillFromFile } from "../../src/core/skills/load-dir.ts";
import { skillItem } from "../../src/octocode/guard/items.ts";
import { gate, scopeFor } from "../../src/octocode/guard/store.ts";
import { tmp } from "./helpers.ts";

let root: string;
let workspace: string;
let alias: string;
let db: AgentDb;
beforeEach(() => {
	root = fs.realpathSync(tmp("octocode-guard-scope-"));
	workspace = path.join(root, "workspace");
	alias = path.join(root, "alias");
	fs.mkdirSync(workspace);
	fs.symlinkSync(workspace, alias);
	db = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
});
afterEach(() => {
	db.close();
	fs.rmSync(root, { recursive: true, force: true });
});

function skill(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "---\nname: scope-fixture\ndescription: Explain the fixture.\n---\nRead the fixture.");
	return file;
}

function firstGate(file: string, cwd: string) {
	const loaded = loadSkillFromFile(file, "project").skill;
	if (!loaded) throw new Error("The actual loader must accept the fixture skill");
	expect(loaded.filePath).toBe(file);
	const scope = scopeFor(loaded.filePath, cwd);
	const item = skillItem({ name: loaded.name, filePath: loaded.filePath, scope });
	const result = gate("skill", [item], { db, enforce: true });
	return { scope, imported: result.imported, allowed: result.allowed.has(item.id) };
}

it("never imports an aliased workspace skill as an existing global approval", () => {
	const file = skill(path.join(alias, ".octocode", "skills", "scope-fixture", "SKILL.md"));
	expect(firstGate(file, alias)).toEqual({ scope: workspace, imported: 0, allowed: false });
});

it("keeps the canonical workspace spelling project-scoped", () => {
	const file = skill(path.join(workspace, ".octocode", "skills", "scope-fixture", "SKILL.md"));
	expect(firstGate(file, workspace)).toEqual({ scope: workspace, imported: 0, allowed: false });
});

it.each([false, true])(
	"keeps a linked project skill project-scoped through an aliased workspace (directory=%s)",
	(directory) => {
		const target = skill(path.join(root, "external", "scope-fixture", "SKILL.md"));
		const folder = path.join(alias, ".octocode", "skills", "scope-fixture");
		const file = path.join(folder, "SKILL.md");
		if (directory) {
			fs.mkdirSync(path.dirname(folder), { recursive: true });
			fs.symlinkSync(path.dirname(target), folder);
		} else {
			fs.mkdirSync(folder, { recursive: true });
			fs.symlinkSync(target, file);
		}
		expect(firstGate(file, alias)).toEqual({ scope: workspace, imported: 0, allowed: false });
	},
);

it("preserves the first import of a genuine outside global skill", () => {
	const file = skill(path.join(root, "workspace-outside", "scope-fixture", "SKILL.md"));
	expect(firstGate(file, alias)).toEqual({ scope: "global", imported: 1, allowed: true });
});
