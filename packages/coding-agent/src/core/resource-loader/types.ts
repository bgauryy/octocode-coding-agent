import type { Theme } from "../../theme/theme.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { EventBus, ListenerErrorReporter } from "@octocodeai/octocode-agent-core";
import type { Feature, InlineExtension, LoadExtensionsResult } from "../features/types.ts";
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

export interface ResourceLoader {
	getEventBus?(): EventBus;
	/** Where a failing event-bus handler is reported from now on (the session's diagnostics); stderr until called. */
	reportHandlerErrorsTo?(report: ListenerErrorReporter): void;
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
	reload(): Promise<void>;
}

export interface DefaultResourceLoaderOptions {
	skillResourceSnapshot?: SkillResourceSnapshot;
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	/** Features registered after the defaults: a bare factory, or one with a name. They count as `builtin`-owned. */
	extensionFactories?: InlineExtension[];
	/** Register the native feature set and the default built-ins. Set false only for a session with its own tool policy. */
	nativeFeatures?: boolean;
	/** Built-in features available to the session, instead of llama.cpp and MCP. Settings can still switch each off. */
	builtinFeatures?: readonly Feature[];
	/** Built-in features not to register, by id (such as `mcp`), even when settings enable them. */
	disabledFeatures?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	/** The folder a trust grant is on: AGENTS.override.md and AGENTS.md load from it down to the working folder, none above it. */
	contextRoot?: string;
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
