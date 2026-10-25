import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
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
import { loadedSkillDirectories, loadSkills } from "../src/core/skills.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as nativeExtension from "../src/octocode/index.ts";
import { prepareOctocodeSkillLaunch } from "../../mcp/src/presets/octocode/skill-paths.ts";

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

	it("lets the bundle replace an installed Pi fallback copy but not an unrelated extension skill", async () => {
		const bundledResearch = join(getBundledSkillsDir(), "octocode-research", "SKILL.md");
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
			bundledResearch,
		);
		const extensionSkill = join(root, "extension-skills", "SKILL.md");
		mkdirSync(join(root, "extension-skills"));
		writeFileSync(extensionSkill, "---\nname: octocode-roast\ndescription: Extension review policy\n---\nExtension");
		loader.extendResources({
			skillPaths: [{ path: extensionSkill, metadata: { source: "extension", scope: "user", origin: "top-level" } }],
		});
		expect(loader.getSkills().skills.find((skill) => skill.name === "octocode-roast")?.filePath).toBe(extensionSkill);
	});

	describe("name collisions with installed copies", () => {
		const copy = (dir: string, name = "octocode-research", description = "Installed copy") => {
			mkdirSync(join(dir, name), { recursive: true });
			writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nCopy`);
			return join(dir, name, "SKILL.md");
		};
		const bundled = (name = "octocode-research") => join(getBundledSkillsDir(), name, "SKILL.md");
		const load = async (settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true })) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, settingsManager });
			await loader.reload();
			return loader;
		};
		const winner = (loader: DefaultResourceLoader, name = "octocode-research") =>
			loader.getSkills().skills.find((skill) => skill.name === name);

		it("lists every bundled skill, once, in a home with no installed copies", async () => {
			const loader = await load();
			const names = loader.getSkills().skills.map((skill) => skill.name);
			const expected = readdirSync(getBundledSkillsDir()).filter((name) =>
				existsSync(join(getBundledSkillsDir(), name, "SKILL.md")),
			);
			expect(names.sort()).toEqual(expected.sort());
			expect(loader.getSkills().diagnostics).toEqual([]);
		});

		it("prefers the bundled skill over the copy ~/.agents/skills holds, and says which one won", async () => {
			const installed = copy(join(root, ".agents", "skills"));
			const loader = await load();
			const skill = winner(loader);
			expect(skill?.filePath).toBe(bundled());
			expect(skill?.sourceInfo.source).toBe("builtin");
			expect(loader.getSkills().diagnostics).toContainEqual(
				expect.objectContaining({
					type: "collision",
					collision: expect.objectContaining({ winnerPath: bundled(), loserPath: installed }),
				}),
			);
		});

		it("prefers the bundled skill over the Claude and Codex copies an extension adds", async () => {
			const claude = copy(join(root, ".claude", "skills"), "octocode-roast");
			const codex = copy(join(root, ".codex", "skills"), "octocode-architect");
			vi.stubEnv("CLAUDE_CONFIG_DIR", "");
			vi.stubEnv("CODEX_HOME", "");
			const loader = await load();
			loader.extendResources({
				skillPaths: [claude, codex].map((path) => ({
					path,
					metadata: { source: "extension:skills", scope: "temporary", origin: "top-level" },
				})),
			});
			expect(winner(loader, "octocode-roast")?.filePath).toBe(bundled("octocode-roast"));
			expect(winner(loader, "octocode-architect")?.filePath).toBe(bundled("octocode-architect"));
		});

		it("keeps the agent directory, project folders, settings entries and --skill ahead of the bundle", async () => {
			const agentCopy = copy(join(agentDir, "skills"), "octocode-research");
			const projectCopy = copy(join(cwd, ".octocode", "skills"), "octocode-roast");
			const projectAgents = copy(join(cwd, ".agents", "skills"), "octocode-architect");
			const chosenDir = join(root, ".agents", "skills");
			const chosen = copy(chosenDir, "octocode-scraping");
			copy(chosenDir, "octocode-skills");
			const explicit = copy(join(root, "explicit"), "octocode-documentation");
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ skills: [join(chosenDir, "octocode-scraping")] }),
			);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noExtensions: true,
				additionalSkillPaths: [join(root, "explicit", "octocode-documentation")],
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			});
			await loader.reload();
			expect(winner(loader)?.filePath).toBe(agentCopy);
			expect(winner(loader, "octocode-roast")?.filePath).toBe(projectCopy);
			expect(winner(loader, "octocode-architect")?.filePath).toBe(projectAgents);
			expect(winner(loader, "octocode-scraping")?.filePath).toBe(chosen);
			expect(winner(loader, "octocode-documentation")?.filePath).toBe(explicit);
			// A sibling in the same folder that no setting names still yields to the bundle.
			expect(winner(loader, "octocode-skills")?.filePath).toBe(bundled("octocode-skills"));
		});

		it("prefers a deliberate copy to the bundle even when an installed copy comes first", async () => {
			copy(join(root, ".agents", "skills"), "octocode-roast");
			const project = copy(join(cwd, ".claude", "skills"), "octocode-roast", "Project policy");
			const loader = await load();
			loader.extendResources({
				skillPaths: [
					{ path: project, metadata: { source: "extension:skills", scope: "temporary", origin: "top-level" } },
				],
			});
			expect(winner(loader, "octocode-roast")?.filePath).toBe(project);
		});

		it("allows the Octocode MCP server to read every bundled skill directory, also beside an installed copy", async () => {
			copy(join(root, ".agents", "skills"), "octocode-research");
			const loader = await load();
			const directories = loadedSkillDirectories(loader.getSkills());
			const bundleDir = realpathSync(getBundledSkillsDir());
			for (const name of readdirSync(bundleDir).filter((entry) => existsSync(join(bundleDir, entry, "SKILL.md"))))
				expect(directories).toContain(join(bundleDir, name));
			const prepared = prepareOctocodeSkillLaunch(
				{ name: "octocode", source: "mcp.json", config: { command: "octocode-mcp" } },
				cwd,
				directories,
				{},
			);
			const allowed = ("url" in prepared.config ? "" : (prepared.config.env?.ALLOWED_PATHS ?? "")).split(",");
			expect(allowed).toContain(join(bundleDir, "octocode-research"));
		});

		it("keeps a user copy of a skill the bundle does not ship", async () => {
			const own = copy(join(root, ".agents", "skills"), "my-own-skill");
			const loader = await load();
			expect(winner(loader, "my-own-skill")?.filePath).toBe(own);
		});
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

	it("disables the shared MCP host while retaining native tools", async () => {
		const native = vi.spyOn(nativeExtension, "default").mockImplementation(() => {});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			disabledBuiltinExtensions: ["mcp"],
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		expect(native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ registerTool: expect.any(Function) }));
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain("builtin:mcp");
	});
});
