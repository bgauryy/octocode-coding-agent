import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { detectCapabilities, getTerminalColorMode } from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import { canonicalizePath, isLocalPath } from "@octocodeai/octocode-common/paths";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { isSkillEnabledBySettings, type PathMetadata } from "../package-manager.ts";
import { effectivePlugins } from "../extensibility/toggles.ts";
import { loadConfiguredPluginPrompts, loadConfiguredPluginSkills } from "../plugin-resources.ts";
import { loadPromptTemplates, type PromptTemplate } from "../prompt-templates.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { adoptSkillResourceSnapshot } from "../skill-resource-snapshot.ts";
import type { ExplicitSkill, LoadSkillsResult, Skill } from "../skills.ts";
import { explicitSkillIdentity, loadSkills, loadSkillsFromDir } from "../skills.ts";
import { createSourceInfo, isSyntheticPath, type SourceInfo } from "../source-info.ts";
import type { EnabledResourcePaths } from "./enabled-resources.ts";
import { mergePaths, resolveResourcePath } from "./paths.ts";
import { skillPathPrecedence } from "./skill-precedence.ts";
import { withheldSkills } from "../skill-review.ts";
import { skillCategory } from "../skills/category.ts";
import { findSourceInfoForPath, getDefaultSourceInfoForPath, type ResourceRoots } from "./source-info.ts";
import { dedupePrompts, dedupeThemes, loadThemes } from "./themes.ts";
import type { DefaultResourceLoaderOptions, ResourceExtensionPaths } from "./types.ts";

/** The loader options and settings that decide which skills, prompt templates and themes load. */
export interface ResourceCollectionsConfig extends Pick<
	DefaultResourceLoaderOptions,
	"skillResourceSnapshot" | "skillsOverride" | "promptsOverride" | "themesOverride"
> {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
	additionalThemePaths: string[];
	noSkills: boolean;
	noPromptTemplates: boolean;
	noThemes: boolean;
}

/** The loaded skills, prompt templates and themes, with their diagnostics and the paths they were loaded from. */
export class ResourceCollections {
	skills: Skill[] = [];
	explicitSkills: ExplicitSkill[] = [];
	skillDiagnostics: ResourceDiagnostic[] = [];
	prompts: PromptTemplate[] = [];
	promptDiagnostics: ResourceDiagnostic[] = [];
	themes: Theme[] = [];
	themeDiagnostics: ResourceDiagnostic[] = [];
	private lastSkillPaths: string[] = [];
	private lastPromptPaths: string[] = [];
	private lastThemePaths: string[] = [];
	private extensionSkillSourceInfos = new Map<string, SourceInfo>();
	private extensionPromptSourceInfos = new Map<string, SourceInfo>();
	private extensionThemeSourceInfos = new Map<string, SourceInfo>();
	private readonly config: ResourceCollectionsConfig;

	constructor(config: ResourceCollectionsConfig) {
		this.config = config;
	}

	/** Forget the source info of extension-supplied paths before a reload. */
	resetExtensionSourceInfos(): void {
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
	}

	/** Load every collection from the enabled resources, reporting missing paths that were named for this run. */
	load(enabled: EnabledResourcePaths, metadataByPath: Map<string, PathMetadata>): void {
		const { additionalSkillPaths, additionalPromptTemplatePaths, additionalThemePaths } = this.config;
		// Paths named for this run (`--skill`) come first: on a name collision they win over installed skills.
		const skillPaths = this.config.noSkills
			? this.mergePaths(additionalSkillPaths, [])
			: this.mergePaths(additionalSkillPaths, enabled.skills);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		for (const p of additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({
						type: "error",
						message: "Skill path does not exist",
						path: resolved,
					});
				}
			}
		}

		// Like `--skill`, `--prompt-template` paths win a name collision.
		const promptPaths = this.config.noPromptTemplates
			? this.mergePaths(additionalPromptTemplatePaths, [])
			: this.mergePaths(additionalPromptTemplatePaths, enabled.prompts);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		for (const p of additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		const themePaths = this.config.noThemes
			? this.mergePaths([], additionalThemePaths)
			: this.mergePaths(enabled.themes, additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		for (const p of additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({
					type: "error",
					message: "Theme path does not exist",
					path: resolved,
				});
			}
		}
	}

	/** Add extension-supplied paths to the loaded collections and reload the collections they change. */
	extend(paths: ResourceExtensionPaths, metadataByPath: Map<string, PathMetadata>): void {
		const skillPaths = this.config.noSkills ? [] : this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				this.skillFilesEnabledBySettings(skillPaths.map((entry) => entry.path)),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths, metadataByPath);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths, metadataByPath);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths, metadataByPath);
		}
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? {
						...entry.metadata,
						baseDir: this.resolveResourcePath(entry.metadata.baseDir),
					}
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		const { skillsOverride } = this.config;
		if (this.config.skillResourceSnapshot) {
			const accepted = adoptSkillResourceSnapshot(this.config.skillResourceSnapshot);
			this.skills = accepted.skills;
			this.explicitSkills = accepted.explicitSkills ?? [];
			this.skillDiagnostics = accepted.diagnostics;
			return;
		}
		let skillsResult: LoadSkillsResult;
		if (this.config.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.config.cwd,
				agentDir: this.config.agentDir,
				skillPaths: [...skillPaths].sort(
					(a, b) =>
						Number(metadataByPath?.get(a)?.source === "builtin") - Number(metadataByPath?.get(b)?.source === "builtin"),
				),
				includeDefaults: false,
				precedence: (path) =>
					skillPathPrecedence(path, {
						metadataByPath,
						extensionPaths: new Set([...this.extensionSkillSourceInfos.keys()].map((key) => resolve(key))),
						agentDir: this.config.agentDir,
					}),
			});
		}
		if (!this.config.noSkills) {
			const pluginSkills = loadConfiguredPluginSkills(
				effectivePlugins(this.config.settingsManager.getSettings(), this.config.cwd),
			);
			skillsResult.skills.push(...pluginSkills.skills);
			skillsResult.explicitSkills = [...(skillsResult.explicitSkills ?? []), ...(pluginSkills.explicitSkills ?? [])];
			skillsResult.diagnostics.push(...pluginSkills.diagnostics);
		}
		const originalIdentities = new Map(
			(skillsResult.explicitSkills ?? []).map((identity) => [identity.skill, identity]),
		);
		const acceptedCanonicalPaths = new Map(
			skillsResult.skills.map((skill) => [resolve(skill.filePath), skill.canonicalPath]),
		);
		const resolvedSkills = skillsOverride ? skillsOverride(skillsResult) : skillsResult;
		if (skillsOverride) {
			resolvedSkills.skills = resolvedSkills.skills.map((skill) => {
				const canonicalPath =
					acceptedCanonicalPaths.get(resolve(skill.filePath)) ??
					(skill.filePath.startsWith("<") ? undefined : canonicalizePath(skill.filePath));
				return canonicalPath === skill.canonicalPath ? skill : { ...skill, canonicalPath };
			});
		}
		const candidates = skillsOverride
			? resolvedSkills.skills.flatMap((skill) => {
					if (skill.userInvocable === false || skill.argumentStyle === "claude") return [];
					const original = originalIdentities.get(skill);
					const identity =
						original && original.discoveryPath === resolve(skill.filePath) && original.name === skill.name
							? original
							: explicitSkillIdentity(skill);
					return identity ? [identity] : [];
				})
			: (skillsResult.explicitSkills ?? []);
		const seenIdentities = new Set<string>();
		this.explicitSkills = candidates.filter((candidate) => {
			if (seenIdentities.has(candidate.canonicalPath)) return false;
			seenIdentities.add(candidate.canonicalPath);
			return true;
		});
		const skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		// The extension guard: a skill Octocode did not ship stays off until the user approved its exact files.
		const reviewed = skills.map((skill) => ({
			name: skill.name,
			filePath: skill.filePath,
			category: skillCategory(skill),
		}));
		const shipped = new Set(
			reviewed.filter((skill) => skill.category === "core" || skill.category === "octocode").map((skill) => skill.name),
		);
		const off = withheldSkills(
			reviewed.filter((skill) => skill.category === "workspace" || skill.category === "global"),
			this.config.cwd,
			shipped,
		);
		this.skills = off.size ? skills.filter((skill) => !off.has(skill.filePath)) : skills;
		if (off.size) this.explicitSkills = this.explicitSkills.filter((identity) => !off.has(identity.skill.filePath));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: {
			prompts: PromptTemplate[];
			diagnostics: ResourceDiagnostic[];
		};
		if (this.config.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const loaded = loadPromptTemplates({
				cwd: this.config.cwd,
				agentDir: this.config.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			const deduped = dedupePrompts(loaded.templates);
			promptsResult = {
				prompts: deduped.prompts,
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		if (!this.config.noPromptTemplates) {
			const plugins = loadConfiguredPluginPrompts(
				effectivePlugins(this.config.settingsManager.getSettings(), this.config.cwd),
			);
			promptsResult.prompts.push(...plugins.prompts);
			promptsResult.diagnostics.push(...plugins.diagnostics);
		}
		const resolvedPrompts = this.config.promptsOverride ? this.config.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.config.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			// Theme construction only needs trueColor, so skip the unrelated tmux hyperlink probe.
			const colorMode = getTerminalColorMode({
				...detectCapabilities(() => false),
				...this.config.settingsManager.getTerminalCapabilityOverrides(),
			});
			const loaded = loadThemes(this.roots(), themePaths, false, colorMode);
			const deduped = dedupeThemes(loaded.themes);
			themesResult = {
				themes: deduped.themes,
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		const resolvedThemes = this.config.themesOverride ? this.config.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	/**
	 * Extension-supplied skill paths with the `skills` setting applied, as it is to auto-discovered skills. Without
	 * exclusion entries the paths pass unchanged; otherwise folders are expanded to their skill files and each is checked.
	 */
	private skillFilesEnabledBySettings(paths: string[]): string[] {
		const { settingsManager } = this.config;
		const exclusion = (pattern: string) => pattern.startsWith("!") || pattern.startsWith("-");
		const globalPatterns = settingsManager.getGlobalSettings().skills ?? [];
		const projectPatterns = settingsManager.isProjectTrusted()
			? (settingsManager.getProjectSettings().skills ?? [])
			: [];
		if (!globalPatterns.some(exclusion) && !projectPatterns.some(exclusion)) return paths;
		return paths.flatMap((path) => {
			const resolved = this.resolveResourcePath(path);
			if (isSyntheticPath(resolved) || !existsSync(resolved)) return [path];
			const directory = statSync(resolved).isDirectory();
			const files = directory
				? loadSkillsFromDir({ dir: resolved, source: "path" }).skills.map((skill) => skill.filePath)
				: [resolved];
			const baseDir = directory ? resolved : dirname(resolved);
			return files.filter((file) => isSkillEnabledBySettings(file, globalPatterns, projectPatterns, baseDir));
		});
	}

	private roots(): ResourceRoots {
		return { cwd: this.config.cwd, agentDir: this.config.agentDir };
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		return findSourceInfoForPath(this.roots(), resourcePath, extraSourceInfos, metadataByPath);
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		return getDefaultSourceInfoForPath(this.roots(), filePath);
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		return mergePaths(this.config.cwd, primary, additional);
	}

	private resolveResourcePath(p: string): string {
		return resolveResourcePath(this.config.cwd, p);
	}
}
