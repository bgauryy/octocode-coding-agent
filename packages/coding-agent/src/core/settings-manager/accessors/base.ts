import type { Settings } from "../../settings-schema.ts";
import type { SettingsPersistence } from "../persistence.ts";
import type { SettingsState } from "../state.ts";

/** Root of the SettingsManager accessor layers; each layer owns the getters and setters of one settings domain. */
export abstract class SettingsAccessorBase {
	protected readonly state: SettingsState;
	protected readonly persistence: SettingsPersistence;

	protected constructor(state: SettingsState, persistence: SettingsPersistence) {
		this.state = state;
		this.persistence = persistence;
	}

	/** Global and project settings merged, with overrides. */
	protected get settings(): Settings {
		return this.state.settings;
	}

	protected get globalSettings(): Settings {
		return this.state.globalSettings;
	}

	protected get projectSettings(): Settings {
		return this.state.projectSettings;
	}

	/** Mark a global field as modified during this session */
	protected markModified(field: keyof Settings, nestedKey?: string): void {
		this.persistence.markModified(field, nestedKey);
	}

	protected save(): void {
		void this.persistence.save();
	}

	protected updateProjectSettings(
		field: keyof Settings,
		update: (settings: Settings) => void,
		nestedKey?: string,
	): void {
		this.persistence.updateProjectSettings(field, update, nestedKey);
	}
}
