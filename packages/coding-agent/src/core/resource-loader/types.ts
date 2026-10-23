import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { EventBus } from "../event-bus.ts";
import type { InlineExtension, LoadExtensionsResult } from "../extensions/types.ts";
import type { PathMetadata } from "../package-manager.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SkillResourceSnapshot } from "../skill-resource-snapshot.ts";
import type { LoadSkillsResult, Skill } from "../skills.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}

export interface ResourceLoader {
	getEventBus?(): EventBus;
	getExtensions(): LoadExtensionsResult;
	getSkills(): LoadSkillsResult;
	getPrompts(): {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

export interface DefaultResourceLoaderOptions {
	skillResourceSnapshot?: SkillResourceSnapshot;
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: InlineExtension[];
	/** Load the native agent features. Set false only when embedding the core with a custom tool policy. */
	nativeFeatures?: boolean;
	noExtensions?: boolean;
	/** Built-in extensions not to load, by name (such as `mcp`), even when settings or `-e` enable them. */
	disabledBuiltinExtensions?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}
