import { existsSync } from "node:fs";
import { getOctocodeSkillsDir } from "../config.ts";
import type { Theme } from "../theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceDiagnostic } from "./diagnostics.ts";

import { resolvePath } from "@octocodeai/octocode-common/paths";
import { createEventBus, type EventBus, type ListenerErrorReporter } from "@octocodeai/octocode-agent-core";
import { discoveryInput } from "./discovery/service.ts";
import { createFeatureRuntime } from "./features/runtime.ts";
import type { Feature, LoadedFeatures } from "./features/types.ts";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { LoadSkillsResult } from "./skills.ts";
import { resetTimings } from "./timings.ts";
import {
	discoverAppendSystemPromptFile,
	discoverSystemPromptFile,
	loadProjectContextFiles,
	resolvePromptInput,
} from "./resource-loader/context-files.ts";
import { ResourceCollections } from "./resource-loader/collections.ts";
import { collectEnabledResources } from "./resource-loader/enabled-resources.ts";
import { FeatureSetLoader, ignoredCodeWarnings } from "./resource-loader/feature-loading.ts";
import type { ResourceRoots } from "./resource-loader/source-info.ts";
import type { DefaultResourceLoaderOptions, ResourceFeaturePaths, ResourceLoader } from "./resource-loader/types.ts";

export { loadProjectContextFiles } from "./resource-loader/context-files.ts";
export type { DefaultResourceLoaderOptions, ResourceFeaturePaths, ResourceLoader } from "./resource-loader/types.ts";

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private reportHandlerError: ListenerErrorReporter = (message) => process.stderr.write(`${message}\n`);
	private packageManager: DefaultPackageManager;
	private injectedFeatures: Feature[];
	private builtinFeatures: readonly Feature[];
	private disabledFeatures: Set<string>;
	private noContextFiles: boolean;
	private contextRoot?: string;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private featuresOverride?: (base: LoadedFeatures) => LoadedFeatures;
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private featuresResult: LoadedFeatures;
	private readonly collections: ResourceCollections;
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[];
	private appendSystemPromptSourcePaths: string[];
	private resourceMetadataByPath: Map<string, PathMetadata>;
	private loaded: boolean;
	private readonly featureLoader: FeatureSetLoader;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		// Reported through the session's diagnostics once one binds them (`reportHandlerErrorsTo`).
		this.eventBus =
			options.eventBus ??
			createEventBus({ onHandlerError: (message, error) => this.reportHandlerError(message, error) });
		const nativeFeatures = options.nativeFeatures;
		this.injectedFeatures = options.features ?? [];
		this.builtinFeatures = options.builtinFeatures ?? nativeFeatures?.builtins ?? [];
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			builtinSkillsDir: nativeFeatures ? getOctocodeSkillsDir() : undefined,
		});
		this.disabledFeatures = new Set(options.disabledFeatures);
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
		this.contextRoot = options.contextRoot;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.featuresOverride = options.featuresOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.featuresResult = {
			features: [],
			errors: [],
			runtime: createFeatureRuntime(),
		};
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.resourceMetadataByPath = new Map();
		this.loaded = false;
		this.featureLoader = new FeatureSetLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			eventBus: this.eventBus,
			packageManager: this.packageManager,
			builtinFeatures: this.builtinFeatures,
			nativeFeature: nativeFeatures?.native,
			injected: this.injectedFeatures,
			disabledFeatures: this.disabledFeatures,
		});
	}

	getEventBus(): EventBus {
		return this.eventBus;
	}

	reportHandlerErrorsTo(report: ListenerErrorReporter): void {
		this.reportHandlerError = report;
	}

	getFeatures(): LoadedFeatures {
		return this.featuresResult;
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

	extendResources(paths: ResourceFeaturePaths): void {
		this.collections.extend(paths, this.resourceMetadataByPath);
	}

	async reload(): Promise<void> {
		resetTimings("features");

		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		await this.settingsManager.reload();
		const resolvedPaths = await this.featureLoader.resolveResources();
		// Kept on the instance so post-reload passes (extendResources) can still resolve package metadata.
		this.resourceMetadataByPath = new Map();
		const metadataByPath = this.resourceMetadataByPath;

		this.collections.resetFeatureSourceInfos();

		const enabled = collectEnabledResources(resolvedPaths, metadataByPath);

		const featuresResult = await this.featureLoader.loadFeatures();
		featuresResult.warnings = ignoredCodeWarnings(
			discoveryInput({
				cwd: this.cwd,
				agentDir: this.agentDir,
				projectTrusted: this.settingsManager.isProjectTrusted(),
			}),
		);
		this.featuresResult = this.featuresOverride ? this.featuresOverride(featuresResult) : featuresResult;

		this.collections.load(enabled, metadataByPath);

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
						contextRoot: this.contextRoot,
						projectTrusted: this.settingsManager.isProjectTrusted(),
						toggles: this.settingsManager.getToggles(),
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

	/**
	 * Resolves and loads the skills (and the other file resources) without running any feature code: what a command
	 * outside a session uses to see the skills a session would load. Not a substitute for `reload`.
	 */
	async loadSkillsOnly(): Promise<void> {
		await this.settingsManager.reload();
		const metadataByPath = new Map();
		this.resourceMetadataByPath = metadataByPath;
		this.collections.resetFeatureSourceInfos();
		const enabled = collectEnabledResources(await this.featureLoader.resolveResources(), metadataByPath);
		this.collections.load(enabled, metadataByPath);
	}

	private roots(): ResourceRoots {
		return { cwd: this.cwd, agentDir: this.agentDir };
	}
}
