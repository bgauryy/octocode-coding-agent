import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	symlinkSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadedSkillDirectories, loadSkills } from "../src/core/skills.ts";
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "skill-identities-"));
	roots.push(root);
	vi.stubEnv("HOME", root);
	for (const dir of ["a", "b"]) {
		mkdirSync(join(root, dir));
		writeFileSync(
			join(root, dir, "SKILL.md"),
			"---\nname: same\ndescription: Same named skill\n---\n" + dir,
		);
	}
	return root;
}
it("preserves both explicit identities while native names keep the first winner", () => {
	const root = setup();
	const result = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: [join(root, "a"), join(root, "b")],
		includeDefaults: false,
	});
	expect(result.skills).toHaveLength(1);
	expect(result.skills[0].filePath).toBe(join(root, "a/SKILL.md"));
	expect(result.explicitSkills?.map((x) => x.canonicalPath)).toEqual([
		realpathSync(join(root, "a/SKILL.md")),
		realpathSync(join(root, "b/SKILL.md")),
	]);
});
it("deduplicates canonical identities and retains the first logical discovery path", () => {
	const root = setup();
	symlinkSync(join(root, "a"), join(root, "alias"));
	const result = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: [join(root, "alias"), join(root, "a")],
		includeDefaults: false,
	});
	expect(result.explicitSkills).toHaveLength(1);
	expect(result.explicitSkills?.[0].discoveryPath).toBe(
		join(root, "alias/SKILL.md"),
	);
	expect(result.explicitSkills?.[0].canonicalPath).toBe(
		realpathSync(join(root, "a/SKILL.md")),
	);
});

it("captures direct directory loader identities before a logical alias changes", async () => {
	const { loadSkillsFromDir } = await import("../src/core/skills.ts");
	const root = setup();
	symlinkSync(join(root, "a"), join(root, "alias"));
	const result = loadSkillsFromDir({
		dir: join(root, "alias"),
		source: "test",
	});
	rmSync(join(root, "alias"));
	symlinkSync(join(root, "b"), join(root, "alias"));
	expect(result.explicitSkills?.[0].canonicalPath).toBe(
		realpathSync(join(root, "a/SKILL.md")),
	);
});
it("treats resource overrides as authoritative without resurrecting name collision candidates", async () => {
	const { DefaultResourceLoader } = await import(
		"../src/core/resource-loader.ts"
	);
	const { SettingsManager } = await import("../src/core/settings-manager.ts");
	const root = setup();
	for (const discard of [false, true]) {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.inMemory({}),
			nativeFeatures: false,
			noExtensions: true,
			noThemes: true,
			noPromptTemplates: true,
			noSkills: true,
			additionalSkillPaths: [
				join(root, "a/SKILL.md"),
				join(root, "b/SKILL.md"),
			],
			skillsOverride: (base) => ({
				skills: discard ? [] : base.skills,
				diagnostics: base.diagnostics,
			}),
		});
		await loader.reload();
		expect(
			loader.getSkills().explicitSkills?.map((s) => s.canonicalPath),
		).toEqual(discard ? [] : [realpathSync(join(root, "a/SKILL.md"))]);
		expect(loadedSkillDirectories(loader.getSkills())).toEqual(
			discard ? [] : [realpathSync(join(root, "a"))],
		);
	}
});
it("retains qualified Codex plugin identities and excludes disabled plugins", async () => {
	const { loadConfiguredPluginSkills } = await import(
		"../src/core/plugin-resources.ts"
	);
	const root = setup();
	mkdirSync(join(root, ".codex-plugin"));
	writeFileSync(
		join(root, ".codex-plugin/plugin.json"),
		JSON.stringify({ name: "kit", skills: ["./a", "./b"] }),
	);
	const loaded = loadConfiguredPluginSkills([
		{ path: root, protocol: "codex" },
	]);
	expect(loaded.skills.map((s) => s.name)).toEqual(["kit:same"]);
	expect(loaded.explicitSkills?.map((s) => s.name)).toEqual([
		"kit:same",
		"kit:same",
	]);
	expect(loaded.explicitSkills?.map((s) => s.promptByteLimit)).toEqual([
		undefined,
		undefined,
	]);
	expect(
		loadConfiguredPluginSkills([
			{ path: root, protocol: "codex", enabled: false },
		]).explicitSkills,
	).toEqual([]);
});
it("passthrough overrides preserve portable limits and captured canonical targets", async () => {
	const { DefaultResourceLoader } = await import(
		"../src/core/resource-loader.ts"
	);
	const { SettingsManager } = await import("../src/core/settings-manager.ts");
	const root = setup();
	mkdirSync(join(root, "skills"));
	mkdirSync(join(root, "project"));
	mkdirSync(join(root, "user"));
	symlinkSync(join(root, "a"), join(root, "skills/alias"));
	writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "kit" }));
	const loader = new DefaultResourceLoader({
		cwd: join(root, "project"),
		agentDir: join(root, "user"),
		settingsManager: SettingsManager.inMemory({
			plugins: [{ path: root, protocol: "codex" }],
		}),
		nativeFeatures: false,
		noExtensions: true,
		noThemes: true,
		noPromptTemplates: true,
		skillsOverride: (base) => {
			rmSync(join(root, "skills/alias"));
			symlinkSync(join(root, "b"), join(root, "skills/alias"));
			return base;
		},
	});
	await loader.reload();
	const identities = loader.getSkills().explicitSkills;
	expect(identities).toHaveLength(1);
	expect(identities?.[0].promptByteLimit).toBe(8000);
	expect(identities?.[0].canonicalPath).toBe(
		realpathSync(join(root, "a/SKILL.md")),
	);
});

it("exposes resource directories for collision candidates and model-only skills", async () => {
	const root = setup();
	writeFileSync(
		join(root, "a/SKILL.md"),
		"---\nname: same\ndescription: Model only\nuser-invocable: false\n---\nbody",
	);
	const loaded = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: [join(root, "a"), join(root, "b")],
		includeDefaults: false,
	});
	expect(loadedSkillDirectories(loaded)).toEqual([
		realpathSync(join(root, "a")),
		realpathSync(join(root, "b")),
	]);
});

it("resource directories retain captured identities when discovery aliases are retargeted", async () => {
	const root = setup();
	symlinkSync(join(root, "a"), join(root, "alias"));
	const loaded = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: [join(root, "alias")],
		includeDefaults: false,
	});
	rmSync(join(root, "alias"));
	symlinkSync(join(root, "b"), join(root, "alias"));
	expect(loadedSkillDirectories(loaded)).toEqual([
		realpathSync(join(root, "a")),
	]);
});

it("does not turn synthetic resources into filesystem grants", () => {
	const root = setup();
	const loaded = loadSkills({
		cwd: root,
		agentDir: root,
		skillPaths: [join(root, "a")],
		includeDefaults: false,
	});
	const skill = {
		...loaded.skills[0],
		filePath: "builtin:virtual",
		sourceInfo: { ...loaded.skills[0].sourceInfo, path: "builtin:virtual" },
	};
	expect(
		loadedSkillDirectories({
			skills: [skill],
			diagnostics: [],
			explicitSkills: [
				{
					skill,
					name: skill.name,
					canonicalPath: "/unloaded/SKILL.md",
					discoveryPath: "/unloaded/SKILL.md",
				},
			],
		}),
	).toEqual([]);
});
