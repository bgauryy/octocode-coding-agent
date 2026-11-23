import type { Settings } from "../settings-schema.ts";
import type { DisplaySettingsApi } from "./api/display.ts";
import type { EnvironmentSettingsApi } from "./api/environment.ts";
import type { ModelSettingsApi } from "./api/model.ts";
import type { ResourceSettingsApi } from "./api/resources.ts";
import type { RuntimeSettingsApi } from "./api/runtime.ts";
import type { SettingsError, SettingsWarning } from "./storage.ts";

/** Settings layers, project trust, reloads, session overrides and the write queue. */
interface SettingsCoreApi {
	/** A copy of the effective settings: global and project settings merged, with overrides. */
	getSettings(): Settings;
	getGlobalSettings(): Settings;
	getProjectSettings(): Settings;
	isProjectTrusted(): boolean;
	setProjectTrusted(trusted: boolean): void;
	reload(): Promise<void>;
	/**
	 * Rewrites one scope's settings through this manager's own storage (the same file, lock and atomic write its saves
	 * use; memory for an in-memory manager) after its queued writes, then reloads, so it reads back what was written.
	 * `rewrite` gets the stored text and returns the new text, or undefined to leave it.
	 */
	rewriteScope(
		scope: "global" | "project",
		rewrite: (current: string | undefined) => string | undefined,
	): Promise<void>;

	/**
	 * Apply additional overrides on top of current settings, without writing them anywhere. A plain override lasts until
	 * the next save or reload; a durable one stays for the life of this manager.
	 */
	applyOverrides(overrides: Partial<Settings>, options?: { durable?: boolean }): void;
	flush(): Promise<void>;
	drainErrors(): SettingsError[];
	/** Settings the loaded files hold that Octocode ignores (unknown or removed root keys), reported once per load. */
	drainWarnings(): SettingsWarning[];
}

/** The SettingsManager instance API, grouped by settings domain. */
export interface SettingsManagerApi
	extends
		SettingsCoreApi,
		ModelSettingsApi,
		RuntimeSettingsApi,
		EnvironmentSettingsApi,
		ResourceSettingsApi,
		DisplaySettingsApi {}
