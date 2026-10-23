import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.ts";
import { getBundledSkillsDir } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills } from "../src/core/skills.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as nativeExtension from "../src/octocode/index.ts";

describe("bundled public skills", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bundled-skills-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv("OCTOCODE_OFFLINE", "1");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("loads the entire installed public collection without installing packages", async () => {
		const bundle = getBundledSkillsDir();
		const expected = readdirSync(bundle)
			.filter((name) => existsSync(join(bundle, name, "SKILL.md")))
			.sort();
		expect(expected.length).toBeGreaterThan(0);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		const skills = loader.getSkills().skills.filter((skill) => skill.sourceInfo.source === "builtin");
		expect(skills.map((skill) => skill.name).sort()).toEqual(expected);
		for (const skill of skills) expect(readFileSync(skill.filePath, "utf8")).toContain("description:");
		expect(existsSync(join(bundle, "octocode-research", "references", "octocode-usage.md"))).toBe(true);
		expect(existsSync(join(bundle, "octocode-research", "scripts", "render-report.mjs"))).toBe(true);
	});

	it("keeps user overrides and symlink deduplication ahead of bundled defaults", async () => {
		const bundledDir = getBundledSkillsDir();
		const override = join(agentDir, "skills", "octocode-research");
		mkdirSync(override, { recursive: true });
		writeFileSync(
			join(override, "SKILL.md"),
			"---\nname: octocode-research\ndescription: Local research policy\n---\nLocal",
		);
		symlinkSync(join(bundledDir, "octocode-roast"), join(agentDir, "skills", "octocode-roast"), "dir");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		const { skills } = loader.getSkills();
		expect(skills.find((skill) => skill.name === "octocode-research")?.filePath).toBe(join(override, "SKILL.md"));
		expect(skills.filter((skill) => skill.name === "octocode-roast")).toHaveLength(1);
	});

	it("honors no-skills and preserves custom core embeddings", async () => {
		for (const options of [{ noSkills: true }, { nativeFeatures: false }]) {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noExtensions: true,
				settingsManager: SettingsManager.inMemory(),
				...options,
			});
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([]);
		}
	});

	it("keeps Pi fallback and extension-discovered skills ahead of the bundle", async () => {
		const legacy = join(root, "pi-agent");
		const skillDir = join(legacy, "skills", "octocode-research");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: octocode-research\ndescription: Pi research policy\n---\nPi");
		vi.spyOn(config, "getLegacyConfigDirs").mockReturnValue([legacy]);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "octocode-research")?.filePath).toBe(
			join(skillDir, "SKILL.md"),
		);
		const extensionSkill = join(root, "extension-skills", "SKILL.md");
		mkdirSync(join(root, "extension-skills"));
		writeFileSync(extensionSkill, "---\nname: octocode-roast\ndescription: Extension review policy\n---\nExtension");
		loader.extendResources({
			skillPaths: [{ path: extensionSkill, metadata: { source: "extension", scope: "user", origin: "top-level" } }],
		});
		expect(loader.getSkills().skills.find((skill) => skill.name === "octocode-roast")?.filePath).toBe(extensionSkill);
	});

	it("still loads explicit paths with no-skills", async () => {
		const explicit = join(root, "explicit");
		mkdirSync(explicit);
		writeFileSync(join(explicit, "SKILL.md"), "---\nname: explicit\ndescription: Explicit skill\n---\nBody");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			additionalSkillPaths: [explicit],
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["explicit"]);
	});

	it("uses normal exclusions and trusted project overrides for bundled skills", async () => {
		mkdirSync(join(cwd, ".octocode"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["!octocode-*"] }));
		writeFileSync(join(cwd, ".octocode", "settings.json"), JSON.stringify({ skills: ["+octocode-research/SKILL.md"] }));
		for (const trusted of [false, true]) {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
			const manager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				builtinSkillsDir: getBundledSkillsDir(),
			});
			const resolved = await manager.resolve();
			const loaded = loadSkills({
				cwd,
				agentDir,
				includeDefaults: false,
				skillPaths: resolved.skills.filter((skill) => skill.enabled).map((skill) => skill.path),
			});
			expect(loaded.skills.map((skill) => skill.name)).toEqual(trusted ? ["octocode-research"] : []);
		}
	});

	it("shows the bundled skill name and persists a working config toggle", async () => {
		const settingsManager = SettingsManager.inMemory();
		const manager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			builtinSkillsDir: getBundledSkillsDir(),
		});
		const resolved = await manager.resolve();
		resolved.skills = resolved.skills.filter((skill) => skill.path.endsWith("/octocode-research/SKILL.md"));
		initTheme("dark");
		const selector = new ConfigSelectorComponent(
			{ global: resolved, project: resolved },
			settingsManager,
			cwd,
			agentDir,
			() => {},
			() => {},
			() => {},
		);
		const rendered = selector.render(120).join("\n");
		expect(rendered).toContain("octocode-research");
		expect(rendered).not.toContain("SKILL.md");
		selector.getResourceList().handleInput(" ");
		expect((await manager.resolve()).skills.find((skill) => skill.path === resolved.skills[0].path)?.enabled).toBe(
			false,
		);
	});

	it("passes no-mcp to the native extension instead of leaving its dedicated client enabled", async () => {
		const native = vi.spyOn(nativeExtension, "default").mockImplementation(() => {});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			disabledBuiltinExtensions: ["mcp"],
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(native).toHaveBeenCalledWith(expect.objectContaining({ registerTool: expect.any(Function) }), {
			mcp: false,
		});
	});
});
