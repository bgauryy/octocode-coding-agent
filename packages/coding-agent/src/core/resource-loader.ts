import { existsSync } from "node:fs";
import { getBundledSkillsDir } from "../config.ts";
import { resolveExtensionFactories } from "./resource-loader/builtins.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { clearExtensionCache, createExtensionRuntime } from "./extensions/loader.ts";
import type { Extension, InlineExtension, LoadExtensionsResult } from "./extensions/types.ts";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { LoadSkillsResult } from "./skills.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";
import { resetTimings } from "./timings.ts";
import {
	type BuiltinExtension,
	collectExtensionPackageWarnings,
	mergeExtensionWarnings,
} from "./resource-loader/extension-sets.ts";
import {
	discoverAppendSystemPromptFile,
	discoverSystemPromptFile,
	loadProjectContextFiles,
	resolvePromptInput,
} from "./resource-loader/context-files.ts";
import { ResourceCollections } from "./resource-loader/collections.ts";
import { collectEnabledResources } from "./resource-loader/enabled-resources.ts";
import { ExtensionSetLoader } from "./resource-loader/extension-loading.ts";
import { mergePaths, resolveResourcePath } from "./resource-loader/paths.ts";
import {
	findSourceInfoForPath,
	getDefaultSourceInfoForPath,
	type ResourceRoots,
} from "./resource-loader/source-info.ts";
import type {
	DefaultResourceLoaderOptions,
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
} from "./resource-loader/types.ts";

export { isBuiltinExtension } from "./resource-loader/extension-sets.ts";
export { loadProjectContextFiles } from "./resource-loader/context-files.ts";
export type {
	DefaultResourceLoaderOptions,
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
} from "./resource-loader/types.ts";

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private extensionFactories: InlineExtension[];
	private nativeFeatures: boolean;
	private builtinExtensions: Map<string, BuiltinExtension>;
	private noExtensions: boolean;
	private disabledBuiltinExtensions: Set<string>;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private readonly collections: ResourceCollections;
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[];
	private appendSystemPromptSourcePaths: string[];
	private resourceMetadataByPath: Map<string, PathMetadata>;
	private loaded: boolean;
	private readonly extensionLoader: ExtensionSetLoader;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.nativeFeatures = options.nativeFeatures !== false;
		const factories = resolveExtensionFactories(options.extensionFactories, this.nativeFeatures);
		this.extensionFactories = factories.extensionFactories;
		this.builtinExtensions = factories.builtinExtensions;
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			builtinExtensions: [...this.builtinExtensions.keys()],
			builtinSkillsDir: this.nativeFeatures ? getBundledSkillsDir() : undefined,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.disabledBuiltinExtensions = new Set(options.disabledBuiltinExtensions);
		this.collections = new ResourceCollections({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			additionalSkillPaths: options.additionalSkillPaths ?? [],
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths ?? [],
			additionalThemePaths: options.additionalThemePaths ?? [],
			noSkills: options.noSkills ?? false,
			noPromptTemplates: options.noPromptTemplates ?? false,
			noThemes: options.noThemes ?? false,
			skillResourceSnapshot: options.skillResourceSnapshot ? structuredClone(options.skillResourceSnapshot) : undefined,
			skillsOverride: options.skillsOverride,
			promptsOverride: options.promptsOverride,
			themesOverride: options.themesOverride,
		});
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = {
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		};
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.resourceMetadataByPath = new Map();
		this.loaded = false;
		this.extensionLoader = new ExtensionSetLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			eventBus: this.eventBus,
			packageManager: this.packageManager,
			additionalExtensionPaths: this.additionalExtensionPaths,
			extensionFactories: this.extensionFactories,
			nativeFeatures: this.nativeFeatures,
			builtinExtensions: this.builtinExtensions,
			noExtensions: this.noExtensions,
			disabledBuiltinExtensions: this.disabledBuiltinExtensions,
		});
	}

	getEventBus(): EventBus {
		return this.eventBus;
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): LoadSkillsResult {
		return {
			skills: this.collections.skills,
			explicitSkills: this.collections.explicitSkills,
			diagnostics: this.collections.skillDiagnostics,
		};
	}

	getPrompts(): {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	} {
		return { prompts: this.collections.prompts, diagnostics: this.collections.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.collections.themes, diagnostics: this.collections.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	extendResources(paths: ResourceExtensionPaths): void {
		this.collections.extend(paths, this.resourceMetadataByPath);
	}

	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		// Force untrusted project settings for the bootstrap pass. This keeps project-local
		// extensions/packages out while still loading user/global and temporary CLI extensions.
		this.settingsManager.setProjectTrusted(false);
		await this.settingsManager.reload();
		return this.extensionLoader.loadCurrentExtensionSet();
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		resetTimings("extensions");

		if (this.loaded) {
			clearExtensionCache();
		}

		let preTrustExtensions: LoadExtensionsResult | undefined;
		if (options?.resolveProjectTrust) {
			preTrustExtensions = await this.loadProjectTrustExtensions();
			const projectTrusted = await options.resolveProjectTrust({
				extensionsResult: preTrustExtensions,
			});
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		await this.settingsManager.reload();
		const resolvedPaths = await this.extensionLoader.resolveResources();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		// Kept on the instance so post-reload passes (extendResources) can still resolve package metadata.
		this.resourceMetadataByPath = new Map();
		const metadataByPath = this.resourceMetadataByPath;

		this.collections.resetExtensionSourceInfos();

		const enabled = collectEnabledResources(resolvedPaths, cliExtensionPaths, metadataByPath);

		const extensionPaths = (
			this.noExtensions ? enabled.cliExtensions : mergePaths(this.cwd, enabled.cliExtensions, enabled.extensions)
		).filter(
			(path) =>
				!path.startsWith(BUILTIN_PATH_PREFIX) ||
				!this.disabledBuiltinExtensions.has(path.slice(BUILTIN_PATH_PREFIX.length)),
		);

		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		const extensionsResult = await this.extensionLoader.loadFinalExtensionSet(extensionPaths, preTrustExtensions);
		mergeExtensionWarnings(extensionsResult, packageWarnings);
		for (const p of this.additionalExtensionPaths) {
			if (isLocalPath(p)) {
				const resolved = resolveResourcePath(this.cwd, p);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({
						path: resolved,
						error: `Extension path does not exist: ${resolved}`,
					});
				}
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		this.collections.load(enabled, metadataByPath);

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
					}),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const systemPromptSource = this.systemPromptSource ?? discoverSystemPromptFile(this.roots(), this.settingsManager);
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
		this.systemPromptSourcePath =
			systemPromptSource && existsSync(systemPromptSource) ? resolvePath(systemPromptSource) : undefined;

		let appendSources = this.appendSystemPromptSource;
		if (!appendSources) {
			const discoveredAppendSystemPromptFile = discoverAppendSystemPromptFile(this.roots(), this.settingsManager);
			appendSources = discoveredAppendSystemPromptFile ? [discoveredAppendSystemPromptFile] : [];
		}
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		this.appendSystemPromptSourcePaths = appendSources
			.filter((source) => existsSync(source))
			.map((source) => resolvePath(source));
		this.loaded = true;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				findSourceInfoForPath(this.roots(), extension.path, undefined, metadataByPath) ??
				getDefaultSourceInfoForPath(this.roots(), extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private roots(): ResourceRoots {
		return { cwd: this.cwd, agentDir: this.agentDir };
	}
}
