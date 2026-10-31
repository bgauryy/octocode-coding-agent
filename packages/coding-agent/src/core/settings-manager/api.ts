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

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void;
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
