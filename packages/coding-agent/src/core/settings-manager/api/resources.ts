import type { PackageSource, Settings } from "../../settings-schema.ts";

/** Packages and resource paths (extensions, skills, prompt templates, themes). Project setters write project settings. */
export interface ResourceSettingsApi {
	getPackages(): PackageSource[];
	setPackages(packages: PackageSource[]): void;
	setProjectPackages(packages: PackageSource[]): void;
	getExtensionPaths(): string[];
	setExtensionPaths(paths: string[]): void;
	setProjectExtensionPaths(paths: string[]): void;
	getSkillPaths(): string[];
	setSkillPaths(paths: string[]): void;
	setProjectSkillPaths(paths: string[]): void;
	getPromptTemplatePaths(): string[];
	setPromptTemplatePaths(paths: string[]): void;
	setProjectPromptTemplatePaths(paths: string[]): void;
	getThemePaths(): string[];
	setThemePaths(paths: string[]): void;
	setProjectThemePaths(paths: string[]): void;
	getEnableSkillCommands(): boolean;
	setEnableSkillCommands(enabled: boolean): void;
	/** Plugin and hook switches by ID; project keys appear with the `project:` prefix (see `mergeToggles`). */
	getToggles(): Record<string, boolean>;
	/** Add a local plugin entry to global or project settings (once per path). */
	addPlugin(scope: "global" | "project", entry: { path: string; protocol: "claude" | "codex" }): void;
	/** Replace the global `plugins` list (marketplace install, update and remove edit entries in place). */
	setGlobalPlugins(plugins: NonNullable<Settings["plugins"]>): void;
	/** The marketplace registry. Global settings only: a project file cannot register one. */
	getMarketplaces(): NonNullable<Settings["marketplaces"]>;
	setMarketplaces(marketplaces: NonNullable<Settings["marketplaces"]>): void;
	/** Switch one ID in global or project settings; `undefined` removes the key. */
	setToggle(scope: "global" | "project", id: string, on: boolean | undefined): void;
}
