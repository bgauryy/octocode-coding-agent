import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getNativeSkillsDir } from "../src/config.ts";
import { configDiscovery, discoveryInput } from "../src/core/discovery/service.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { collectionSkillFiles } from "../src/core/skills/collection.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-skill-collection-")));
	roots.push(root);
	return root;
}

function writeSkill(dir: string, name: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture\n---\nBody`);
}

const names = (files: readonly string[]) => files.map((file) => basename(dirname(file))).sort();

it("leaves out a collection skill whose name a core skill has", () => {
	const core = folder();
	const collection = folder();
	writeSkill(core, "shared");
	writeSkill(collection, "shared");
	writeSkill(collection, "own");
	expect(names(collectionSkillFiles(collection, core))).toEqual(["own"]);
});

it("does not offer the shipped core skills twice: the collection copy is neither resolved nor discovered", async () => {
	const coreName = "octocode-debugging";
	expect(existsSync(join(getNativeSkillsDir(), coreName, "SKILL.md"))).toBe(true);
	const root = folder();
	const collection = join(root, "collection");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true });
	writeSkill(collection, coreName);
	writeSkill(collection, "collection-only");

	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
		builtinSkillsDir: collection,
	}).resolve(async () => "skip");
	const offered = resolved.skills.filter((skill) => skill.metadata.source === "builtin").map((skill) => skill.path);
	expect(names(offered)).toEqual(["collection-only"]);

	const discovered = configDiscovery
		.discover(
			"skill",
			discoveryInput({ cwd, agentDir, projectTrusted: false, home: join(root, "home"), builtinSkillsDir: collection }),
		)
		.filter((item) => item.provenance.scope === "builtin")
		.map((item) => item.name);
	expect(discovered).toEqual(["collection-only"]);
});
