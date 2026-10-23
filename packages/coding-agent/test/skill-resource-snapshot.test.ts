import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	captureSkillResourceSnapshot,
	adoptSkillResourceSnapshot,
	readSkillResourceSnapshot,
} from "../src/core/skill-resource-snapshot.ts";
import { loadedSkillDirectories, type Skill } from "../src/core/skills.ts";

function selectSkillResourceSnapshot(
	snapshot: Parameters<typeof adoptSkillResourceSnapshot>[0],
	names: readonly string[],
	commands: Parameters<typeof captureSkillResourceSnapshot>[2],
) {
	return captureSkillResourceSnapshot(adoptSkillResourceSnapshot(snapshot), names, commands);
}
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-snapshot-")));
	roots.push(root);
	const make = (name: string, folder = name): Skill => {
		const dir = path.join(root, folder);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: fixture\n---\nbody`);
		return {
			name,
			description: "fixture",
			filePath,
			baseDir: dir,
			sourceInfo: {
				path: filePath,
				source: "test",
				scope: "user",
				origin: "top-level",
			},
			disableModelInvocation: false,
		};
	};
	return { root, make };
}
it("retains visible policy and hidden explicit identity without plugin discovery", () => {
	const { make } = fixture();
	const model = make("model");
	model.userInvocable = false;
	const visible = make("plugin:route", "visible");
	const hidden = make("route", "hidden");
	const snapshot = captureSkillResourceSnapshot({
		skills: [model, visible],
		explicitSkills: [
			{
				skill: hidden,
				name: "route",
				canonicalPath: hidden.filePath,
				discoveryPath: hidden.filePath,
				promptByteLimit: 8000,
			},
		],
		diagnostics: [],
	});
	const loaded = adoptSkillResourceSnapshot(JSON.parse(JSON.stringify(snapshot)));
	expect(loaded.skills.map((s) => s.name)).toEqual(["model", "plugin:route"]);
	expect(loaded.skills[0].userInvocable).toBe(false);
	expect(loaded.explicitSkills?.[0]).toMatchObject({
		name: "route",
		promptByteLimit: 8000,
		skill: { name: "route" },
	});
	expect(loadedSkillDirectories(loaded)).toContain(hidden.baseDir);
});
it("keeps captured canonical instructions and references after discovery symlink retarget", () => {
	const { root, make } = fixture();
	const original = make("route", "original"),
		replacement = make("other", "replacement"),
		link = path.join(root, "link");
	fs.symlinkSync(original.baseDir, link);
	const skill = {
		...original,
		filePath: path.join(link, "SKILL.md"),
		baseDir: link,
	};
	const snapshot = captureSkillResourceSnapshot({
		skills: [skill],
		explicitSkills: [
			{
				skill,
				name: "route",
				canonicalPath: original.filePath,
				discoveryPath: skill.filePath,
			},
		],
		diagnostics: [],
	});
	fs.unlinkSync(link);
	fs.symlinkSync(replacement.baseDir, link);
	const loaded = adoptSkillResourceSnapshot(snapshot);
	expect(loaded.skills[0].filePath).toBe(original.filePath);
	expect(loadedSkillDirectories(loaded)).toEqual([original.baseDir]);
	expect(loaded.explicitSkills?.[0].discoveryPath).toBe(skill.filePath);
});
it("rejects changed canonical identities, malformed metadata, synthetic resources and unsupported versions", () => {
	const { make } = fixture();
	const skill = make("route"),
		other = make("other");
	const snapshot = captureSkillResourceSnapshot({
		skills: [skill],
		diagnostics: [],
	});
	expect(() => adoptSkillResourceSnapshot({ ...snapshot, version: 2 })).toThrow();
	const bad = structuredClone(snapshot);
	bad.resources[0].skill.sourceInfo.scope = "invalid" as never;
	expect(() => adoptSkillResourceSnapshot(bad)).toThrow();
	expect(() =>
		captureSkillResourceSnapshot({
			skills: [{ ...skill, filePath: "<inline:route>" }],
			diagnostics: [],
		}),
	).toThrow();
	fs.unlinkSync(skill.filePath);
	fs.symlinkSync(other.filePath, skill.filePath);
	expect(() => adoptSkillResourceSnapshot(snapshot)).toThrow();
});
it("keeps explicit empty selection empty and refuses unknown selection", () => {
	const { make } = fixture();
	const skill = make("route");
	const snapshot = captureSkillResourceSnapshot({
		skills: [skill],
		diagnostics: [],
	});
	const commands = [
		{
			name: "route",
			aliases: ["skill:route"],
			description: "fixture",
			source: "skill" as const,
			sourceInfo: skill.sourceInfo,
		},
	];
	expect(adoptSkillResourceSnapshot(selectSkillResourceSnapshot(snapshot, [], commands)).skills).toEqual([]);
	expect(
		adoptSkillResourceSnapshot(selectSkillResourceSnapshot(snapshot, ["skill:route"], commands)).skills,
	).toHaveLength(1);
	expect(() => selectSkillResourceSnapshot(snapshot, ["unknown"], commands)).toThrow();
});
it("refuses to pass a user-only skill to a child, whose model could never see it", () => {
	const { make } = fixture();
	const skill = make("deploy");
	skill.disableModelInvocation = true;
	const commands = [
		{ name: "deploy", aliases: [], description: "fixture", source: "skill" as const, sourceInfo: skill.sourceInfo },
	];
	expect(() => captureSkillResourceSnapshot({ skills: [skill], diagnostics: [] }, ["deploy"], commands)).toThrow(
		'Skill "deploy" sets disable-model-invocation',
	);
	// Inheriting the whole catalog keeps it, hidden from the child's model as in the parent.
	expect(captureSkillResourceSnapshot({ skills: [skill], diagnostics: [] }).resources).toHaveLength(1);
});
it("drops an inherited skill whose file was deleted, keeping the rest", () => {
	const { make } = fixture();
	const kept = make("kept");
	const deleted = make("deleted");
	const snapshot = captureSkillResourceSnapshot({ skills: [kept, deleted], diagnostics: [] });
	fs.rmSync(path.dirname(deleted.filePath), { recursive: true });
	const loaded = adoptSkillResourceSnapshot(snapshot);
	expect(loaded.skills.map((skill) => skill.name)).toEqual(["kept"]);
	expect(loaded.explicitSkills?.map((identity) => identity.name)).toEqual(["kept"]);
	expect(loaded.diagnostics).toEqual([
		{
			type: "warning",
			message: "Inherited skill file no longer exists; the skill was not loaded",
			path: deleted.filePath,
		},
	]);
});
it("rejects symlink transport files and oversized input without fallback", () => {
	const { root } = fixture();
	const file = path.join(root, "snapshot.json"),
		link = path.join(root, "link.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, resources: [], explicitSkills: [] }), { mode: 0o600 });
	fs.symlinkSync(file, link);
	expect(() => readSkillResourceSnapshot(link)).toThrow();
	fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
	expect(() => readSkillResourceSnapshot(file)).toThrow();
});

it("preserves undefined explicit fallback while honoring an explicitly empty inventory", () => {
	const { make } = fixture();
	const skill = make("route");
	expect(
		adoptSkillResourceSnapshot(captureSkillResourceSnapshot({ skills: [skill], diagnostics: [] })).explicitSkills,
	).toHaveLength(1);
	expect(
		adoptSkillResourceSnapshot(
			captureSkillResourceSnapshot({
				skills: [skill],
				explicitSkills: [],
				diagnostics: [],
			}),
		).explicitSkills,
	).toEqual([]);
});
it("recaptures the original discovery alias and byte cap after canonical adoption", () => {
	const { root, make } = fixture();
	const skill = make("route"),
		link = path.join(root, "link");
	fs.symlinkSync(skill.baseDir, link);
	const discoveryPath = path.join(link, "SKILL.md"),
		logical = { ...skill, filePath: discoveryPath, baseDir: link };
	const first = captureSkillResourceSnapshot({
		skills: [logical],
		explicitSkills: [
			{
				skill: logical,
				name: "route",
				canonicalPath: skill.filePath,
				discoveryPath,
				promptByteLimit: 8000,
			},
		],
		diagnostics: [],
	});
	expect(captureSkillResourceSnapshot(adoptSkillResourceSnapshot(first))).toEqual({
		...first,
		resources: first.resources.map((r) => ({
			...r,
			skill: { ...r.skill, baseDir: skill.baseDir },
		})),
	});
});
it("selects exact visible identities for shared paths, reserved names and duplicate names", () => {
	const { make } = fixture();
	const one = make("route"),
		alias = { ...one, name: "other" },
		duplicate = make("route", "second");
	const snapshot = captureSkillResourceSnapshot({
		skills: [one, alias, duplicate],
		explicitSkills: [],
		diagnostics: [],
	});
	const commands = [
		{
			name: "route",
			description: "reserved",
			source: "extension" as const,
			sourceInfo: one.sourceInfo,
		},
		...[
			{ name: "skill:route:1", skill: one },
			{ name: "other", skill: alias },
			{ name: "skill:route:2", skill: duplicate },
		].map(({ name, skill }) => ({
			name,
			description: "skill",
			source: "skill" as const,
			sourceInfo: skill.sourceInfo,
		})),
	];
	expect(selectSkillResourceSnapshot(snapshot, ["other"], commands).resources.map((r) => r.skill.name)).toEqual([
		"other",
	]);
	expect(selectSkillResourceSnapshot(snapshot, ["skill:route:2"], commands).resources[0].canonicalPath).toBe(
		duplicate.filePath,
	);
	expect(() => selectSkillResourceSnapshot(snapshot, ["route"], commands)).toThrow();
});
it("rejects corrupt transport text, public mode, excess records and invalid references", () => {
	const { root, make } = fixture();
	const skill = make("route"),
		snapshot = captureSkillResourceSnapshot({
			skills: [skill],
			diagnostics: [],
		});
	expect(() =>
		adoptSkillResourceSnapshot({
			...snapshot,
			resources: Array.from({ length: 4097 }, () => snapshot.resources[0]),
		}),
	).toThrow();
	expect(() =>
		adoptSkillResourceSnapshot({
			...snapshot,
			explicitSkills: [{ resource: 100, name: "route" }],
		}),
	).toThrow();
	const file = path.join(root, "bad.json");
	const valid = JSON.stringify(snapshot);
	const descriptionAt = valid.indexOf('"description":"') + '"description":"'.length;
	fs.writeFileSync(
		file,
		Buffer.concat([
			Buffer.from(valid.slice(0, descriptionAt)),
			Buffer.from([0xff]),
			Buffer.from(valid.slice(descriptionAt)),
		]),
		{ mode: 0o600 },
	);
	expect(() => readSkillResourceSnapshot(file)).toThrow(/encoded data|encoding/i);
	fs.writeFileSync(file, JSON.stringify(snapshot));
	fs.chmodSync(file, 0o644);
	if (process.platform !== "win32") expect(() => readSkillResourceSnapshot(file)).toThrow();
});
it("adopts snapshot skills authoritatively without default paths or skill overrides", async () => {
	const { root, make } = fixture();
	const skill = make("accepted"),
		extra = make("unrelated");
	const { DefaultResourceLoader } = await import("../src/core/resource-loader.ts");
	const { SettingsManager } = await import("../src/core/settings-manager.ts");
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: path.join(root, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		nativeFeatures: false,
		noExtensions: true,
		additionalSkillPaths: [extra.filePath],
		skillResourceSnapshot: captureSkillResourceSnapshot({
			skills: [skill],
			diagnostics: [],
		}),
		skillsOverride: () => {
			throw new Error("snapshot must bypass skill override");
		},
	});
	await loader.reload();
	expect(loader.getSkills().skills.map((s) => s.name)).toEqual(["accepted"]);
});

it("captures empty or healthy subsets before checking unrelated invalid resources", () => {
	const { make } = fixture();
	const good = make("good"),
		bad = { ...make("bad"), filePath: "<inline:bad>" };
	const loaded = { skills: [good, bad], explicitSkills: [], diagnostics: [] };
	const commands = [
		{
			name: "good",
			description: "fixture",
			source: "skill" as const,
			sourceInfo: good.sourceInfo,
		},
	];
	expect(captureSkillResourceSnapshot(loaded, [], commands).resources).toEqual([]);
	expect(captureSkillResourceSnapshot(loaded, ["good"], commands).resources.map((r) => r.skill.name)).toEqual(["good"]);
});

it("the bound extension API selects healthy resources without inspecting unrelated invalid files", async () => {
	const { make } = fixture();
	const good = make("good"),
		bad = { ...make("bad"), filePath: "<inline:bad>" };
	const { createHarness } = await import("./suite/harness.ts");
	let api: import("../src/core/extensions/types.ts").ExtensionAPI | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		h.session.resourceLoader.getSkills = () => ({
			skills: [good, bad],
			explicitSkills: [],
			diagnostics: [],
		});
		await h.session.bindExtensions({});
		expect(api!.getSkillResourceSnapshot([]).resources).toEqual([]);
		expect(api!.getSkillResourceSnapshot(["good"]).resources.map((r) => r.skill.name)).toEqual(["good"]);
		expect(() => api!.getSkillResourceSnapshot()).toThrow(/Synthetic/);
	} finally {
		h.cleanup();
	}
});

it.each(["model-only", "claude"] as const)(
	"retains accepted %s canonical identity without an explicit mention record",
	async (kind) => {
		const { root, make } = fixture();
		const original = make("route", "original"),
			replacement = make("other", "replacement");
		if (kind === "model-only")
			fs.writeFileSync(
				original.filePath,
				"---\nname: route\ndescription: original\nuser-invocable: false\n---\noriginal body",
			);
		const parent = path.join(root, kind === "claude" ? ".claude/skills" : "skills");
		fs.mkdirSync(parent, { recursive: true });
		const alias = path.join(parent, "route");
		fs.symlinkSync(original.baseDir, alias);
		const { loadSkills } = await import("../src/core/skills.ts");
		const loaded = loadSkills({
			cwd: root,
			agentDir: path.join(root, "agent"),
			skillPaths: [alias],
			includeDefaults: false,
		});
		expect(loaded.skills).toHaveLength(1);
		expect(loaded.explicitSkills).toEqual([]);
		fs.unlinkSync(alias);
		fs.symlinkSync(replacement.baseDir, alias);
		expect(loadedSkillDirectories(loaded)).toEqual([original.baseDir]);
		const inherited = adoptSkillResourceSnapshot(captureSkillResourceSnapshot(loaded));
		expect(inherited.skills[0].filePath).toBe(original.filePath);
	},
);

it("recaptures an override's changed file path without inheriting the old canonical target", async () => {
	const { root, make } = fixture();
	const original = make("route", "original"),
		replacement = make("replacement");
	const { DefaultResourceLoader } = await import("../src/core/resource-loader.ts");
	const { SettingsManager } = await import("../src/core/settings-manager.ts");
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: path.join(root, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		nativeFeatures: false,
		noExtensions: true,
		additionalSkillPaths: [original.filePath],
		skillsOverride: (base) => ({
			...base,
			skills: base.skills.map((skill) => ({
				...skill,
				filePath: replacement.filePath,
				baseDir: replacement.baseDir,
			})),
		}),
	});
	await loader.reload();
	expect(loader.getSkills().skills[0].canonicalPath).toBe(replacement.filePath);
	expect(loadedSkillDirectories(loader.getSkills())).toEqual([replacement.baseDir]);
	expect(captureSkillResourceSnapshot(loader.getSkills()).resources[0].canonicalPath).toBe(replacement.filePath);
});

it("reads Codex sidecar policy beside the canonical skill file", async () => {
	const { root, make } = fixture();
	const target = make("route", "target");
	const aliasDir = path.join(root, "alias");
	fs.mkdirSync(path.join(aliasDir, "agents"), { recursive: true });
	fs.mkdirSync(path.join(target.baseDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(aliasDir, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: true\n");
	fs.writeFileSync(path.join(target.baseDir, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
	const alias = path.join(aliasDir, "SKILL.md");
	fs.symlinkSync(target.filePath, alias);
	const { loadSkills } = await import("../src/core/skills.ts");
	const loaded = loadSkills({
		cwd: root,
		agentDir: path.join(root, "agent"),
		skillPaths: [alias],
		includeDefaults: false,
	});
	expect(loaded.skills).toHaveLength(1);
	expect(loaded.skills[0].disableModelInvocation).toBe(true);
	expect(loaded.skills[0].canonicalPath).toBe(target.filePath);
});
