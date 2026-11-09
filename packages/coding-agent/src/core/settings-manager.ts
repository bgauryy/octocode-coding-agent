import { mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { resolvePath } from "../../../common/src/paths.ts";
import type { Settings } from "./settings-schema.ts";

export type {
	CacheWarmingMode,
	FullscreenExitOutput,
	MermaidRenderingMode,
	PackageSource,
	QuietStartup,
	Settings,
	TuiMode,
	WarningSettings,
} from "./settings-schema.ts";
export { CACHE_WARMING_MODES } from "./settings-manager/constants.ts";

import { DisplaySettingsAccessors } from "./settings-manager/accessors/display.ts";
import type { SettingsManagerApi } from "./settings-manager/api.ts";
import { migrateSettings, tryLoadSettingsFromStorage } from "./settings-manager/load.ts";
import { watchProviderToggles } from "./settings-manager/provider-watch.ts";
import { deepMergeSettings, effectiveSettings, mergeAllSettings } from "./settings-manager/merge.ts";
import { SettingsPersistence } from "./settings-manager/persistence.ts";
import type { SettingsState } from "./settings-manager/state.ts";
import {
	FileSettingsStorage,
	InMemorySettingsStorage,
	type SettingsError,
	type SettingsManagerCreateOptions,
	type SettingsPaths,
	type SettingsStorage,
	type SettingsWarning,
	toSettingsError,
} from "./settings-manager/storage.ts";

export {
	FileSettingsStorage,
	InMemorySettingsStorage,
	type SettingsManagerCreateOptions,
	type SettingsStorage,
} from "./settings-manager/storage.ts";
export {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
} from "./settings-manager/tool-list.ts";

/**
 * Global and project settings, merged with project settings taking precedence. Accessors live in the domain layers
 * under `settings-manager/accessors/`; writes go through {@link SettingsPersistence}.
 */
export class SettingsManager extends DisplaySettingsAccessors implements SettingsManagerApi {
	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = false,
		settingsPaths: SettingsPaths = {},
	) {
		const state: SettingsState = {
			storage,
			inheritedSettings: {},
			globalSettings: initialGlobal,
			projectSettings: initialProject,
			settings: mergeAllSettings({}, initialGlobal, initialProject),
			durableOverrides: {},
			cacheOverrides: {},
			projectTrusted,
			globalSettingsLoadError: globalLoadError,
			projectSettingsLoadError: projectLoadError,
			errors: [...initialErrors],
			warnings: [],
			settingsPaths,
		};
		super(state, new SettingsPersistence(state));
	}

	/** Create a SettingsManager that loads from files */
	/**
	 * Settings for startup decisions made before a session exists (where sessions are stored): a project's settings
	 * apply only when the host already knows the user trusts that folder (`projectTrusted`, from the folder-trust port).
	 */
	static createForStartup(
		cwd: string,
		agentDir: string = getAgentDir(),
		projectTrusted: boolean = false,
	): SettingsManager {
		return SettingsManager.create(cwd, agentDir, { projectTrusted });
	}

	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		// Untrusted unless the caller established trust: project settings and project resources must not load by default.
		const projectTrusted = options.projectTrusted ?? false;
		const globalLoad = tryLoadSettingsFromStorage(storage, "global");
		const projectLoad = tryLoadSettingsFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		const manager = new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
		manager.persistence.recordIgnoredKeys("global", globalLoad.settings);
		manager.persistence.recordIgnoredKeys("project", projectLoad.settings);
		manager.refreshInherited();
		return manager;
	}

	/**
	 * Read the settings another product (Pi) left, under global and project settings. They only feed `getSettings()`:
	 * the scope settings that are saved never hold them. A file that does not parse is a warning, not a load error.
	 */
	private refreshInherited(): void {
		const state = this.state;
		const inherited = state.storage.loadInherited?.(state.projectTrusted);
		state.warnings = state.warnings.filter((warning) => !warning.message.startsWith("Pi settings were not read"));
		if (inherited) state.warnings.push(...inherited.warnings);
		// Pi's values never stand in for Octocode's own file while that file is invalid.
		state.inheritedSettings = inherited && !state.globalSettingsLoadError ? migrateSettings(inherited.settings) : {};
		state.settings = effectiveSettings(state);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = migrateSettings(structuredClone(settings));
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	getSettings(): Settings {
		return structuredClone(this.state.settings);
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.state.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.state.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.state.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		const state = this.state;
		if (state.projectTrusted === trusted) {
			return;
		}

		state.projectTrusted = trusted;
		this.persistence.clearModifiedScope("project");

		if (!trusted) {
			state.projectSettings = {};
			state.projectSettingsLoadError = null;
			this.refreshInherited();
			return;
		}

		const projectLoad = tryLoadSettingsFromStorage(state.storage, "project", trusted);
		state.projectSettings = projectLoad.settings;
		state.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.persistence.recordError("project", projectLoad.error);
		} else {
			this.persistence.recordIgnoredKeys("project", projectLoad.settings);
		}
		this.refreshInherited();
	}

	async reload(): Promise<void> {
		await this.persistence.pendingWrites;
		const state = this.state;
		const globalLoad = tryLoadSettingsFromStorage(state.storage, "global");
		if (!globalLoad.error) {
			state.globalSettings = globalLoad.settings;
			state.globalSettingsLoadError = null;
			this.persistence.recordIgnoredKeys("global", globalLoad.settings);
		} else {
			state.globalSettingsLoadError = globalLoad.error;
			this.persistence.recordError("global", globalLoad.error);
		}

		this.persistence.clearModifiedScope("global");
		this.persistence.clearModifiedScope("project");

		const projectLoad = tryLoadSettingsFromStorage(state.storage, "project", state.projectTrusted);
		if (!projectLoad.error) {
			state.projectSettings = projectLoad.settings;
			state.projectSettingsLoadError = null;
			this.persistence.recordIgnoredKeys("project", projectLoad.settings);
		} else {
			state.projectSettingsLoadError = projectLoad.error;
			this.persistence.recordError("project", projectLoad.error);
		}

		this.refreshInherited();
	}

	/** Calls `onChange` when another process changes the global `disabledProviders` or `providerSources`, after adopting them. Returns the stop function. */
	watchProviderToggles(onChange: () => void, intervalMs?: number): () => void {
		return watchProviderToggles(this.state, onChange, intervalMs);
	}

	applyOverrides(overrides: Partial<Settings>, options?: { durable?: boolean }): void {
		if (options?.durable) this.state.durableOverrides = deepMergeSettings(this.state.durableOverrides, overrides);
		this.state.cacheOverrides = mergeCachePreferences([
			{ source: "previous override", values: this.state.cacheOverrides },
			{ source: "override", values: overrides },
		]).options;
		this.state.settings = deepMergeSettings(this.state.settings, overrides);
	}

	async flush(): Promise<void> {
		await this.persistence.pendingWrites;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.state.errors];
		this.state.errors = [];
		return drained;
	}

	drainWarnings(): SettingsWarning[] {
		const drained = [...this.state.warnings];
		this.state.warnings = [];
		return drained;
	}
}
