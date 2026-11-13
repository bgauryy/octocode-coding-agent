import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { effectiveSettings } from "./merge.ts";
import type { SettingsPersistence } from "./persistence.ts";
import type { SettingsState } from "./state.ts";

export interface DefaultModelSelectionOptions {
	thinkingLevel?: ThinkingLevel;
	enabledModels?: string[];
}

const pendingSelections = new WeakMap<SettingsState, Promise<void>>();

/** Serialize default-model choices so a failed write cannot roll another choice back to an uncommitted value. */
export function saveDefaultModelSelection(
	state: SettingsState,
	persistence: SettingsPersistence,
	provider: string,
	modelId: string,
	options: DefaultModelSelectionOptions = {},
): Promise<void> {
	const previous = pendingSelections.get(state) ?? Promise.resolve();
	const snapshot = { ...options, ...(options.enabledModels ? { enabledModels: [...options.enabledModels] } : {}) };
	const saved = previous
		.catch(() => undefined)
		.then(() => commitSelection(state, persistence, provider, modelId, snapshot));
	pendingSelections.set(state, saved);
	const forget = () => {
		if (pendingSelections.get(state) === saved) pendingSelections.delete(state);
	};
	void saved.then(forget, forget);
	return saved;
}

/** Commit all fields together; retain diagnostics and restore the attempted settings if storage fails. */
async function commitSelection(
	state: SettingsState,
	persistence: SettingsPersistence,
	provider: string,
	modelId: string,
	options: DefaultModelSelectionOptions,
): Promise<void> {
	if (state.globalSettingsLoadError) throw state.globalSettingsLoadError;
	const global = state.globalSettings;
	const previous = { ...global };
	const key = `${provider}/${modelId}`;
	const enabledModels = options.enabledModels && [...options.enabledModels];
	global.defaultProvider = provider;
	global.defaultModel = modelId;
	persistence.markModified("defaultProvider");
	persistence.markModified("defaultModel");
	if (options.thinkingLevel !== undefined) {
		global.modelThinkingLevels = { ...global.modelThinkingLevels, [key]: options.thinkingLevel };
		persistence.markModified("modelThinkingLevels", key);
	}
	if (enabledModels !== undefined) {
		global.enabledModels = enabledModels;
		persistence.markModified("enabledModels");
	}
	const error = await persistence.save();
	if (!error) return;
	// A later model choice owns its own fields; do not roll it back with this attempt's failure.
	if (global.defaultProvider === provider && global.defaultModel === modelId) {
		if (previous.defaultProvider === undefined) delete global.defaultProvider;
		else global.defaultProvider = previous.defaultProvider;
		if (previous.defaultModel === undefined) delete global.defaultModel;
		else global.defaultModel = previous.defaultModel;
	}
	if (options.thinkingLevel !== undefined && global.modelThinkingLevels?.[key] === options.thinkingLevel) {
		const oldLevel = previous.modelThinkingLevels?.[key];
		if (oldLevel === undefined) delete global.modelThinkingLevels[key];
		else global.modelThinkingLevels[key] = oldLevel;
		if (previous.modelThinkingLevels === undefined && Object.keys(global.modelThinkingLevels).length === 0)
			delete global.modelThinkingLevels;
	}
	if (enabledModels !== undefined && global.enabledModels === enabledModels) {
		if (previous.enabledModels === undefined) delete global.enabledModels;
		else global.enabledModels = previous.enabledModels;
	}
	state.settings = effectiveSettings(state);
	throw error;
}
