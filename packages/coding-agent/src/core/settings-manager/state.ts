import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { Settings } from "../settings-schema.ts";
import type { SettingsError, SettingsPaths, SettingsStorage } from "./storage.ts";

/** Mutable state of one SettingsManager, shared by its persistence and its accessors. */
export interface SettingsState {
	storage: SettingsStorage;
	globalSettings: Settings;
	projectSettings: Settings;
	/** Global and project settings merged, with overrides. */
	settings: Settings;
	cacheOverrides: CachePreferences;
	projectTrusted: boolean;
	globalSettingsLoadError: Error | null; // Track if global settings file had parse errors
	projectSettingsLoadError: Error | null; // Track if project settings file had parse errors
	errors: SettingsError[];
	settingsPaths: SettingsPaths;
}
