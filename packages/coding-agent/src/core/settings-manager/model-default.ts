import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { effectiveSettings } from "./merge.ts";
import type { SettingsPersistence } from "./persistence.ts";
import type { SettingsState } from "./state.ts";

export interface DefaultModelSelectionOptions {
	thinkingLevel?: ThinkingLevel;
	enabledModels?: string[];
	/** `project` writes only the project's default model (a trusted project is required); thinking level and enabled models stay global. */
	scope?: "global" | "project";
}

const pendingSelections = new WeakMap<SettingsState, Promise<void>>();

/** Serialize default-model choices so a failed write cannot roll another choice back to an uncommitted value. */
export function saveDefaultModelSelection(
	state: SettingsState,
	persistence: SettingsPersistence,
	provider: string,
	modelId: string | undefined,
	options: DefaultModelSelectionOptions = {},
): Promise<void> {
	if (options.scope === "project") {
		return queueSelection(state, async () => {
			persistence.updateProjectSettings(["defaultProvider", "defaultModel"], (settings) => {
				settings.defaultProvider = provider;
				if (modelId === undefined) delete settings.defaultModel;
				else settings.defaultModel = modelId;
			});
		});
	}
	const snapshot = { ...options, ...(options.enabledModels ? { enabledModels: [...options.enabledModels] } : {}) };
	return queueSelection(state, () => commitSelection(state, persistence, provider, modelId, snapshot));
}

function queueSelection(state: SettingsState, commit: () => Promise<void>): Promise<void> {
	const previous = pendingSelections.get(state) ?? Promise.resolve();
	const saved = previous.catch(() => undefined).then(commit);
	pendingSelections.set(state, saved);
	const forget = () => {
		if (pendingSelections.get(state) === saved) pendingSelections.delete(state);
	};
	void saved.then(forget, forget);
	return saved;
}

/** Update just this provider's preferred model under the settings-file lock. Other provider preferences survive concurrent writes. */
export function saveProviderModel(
	state: SettingsState,
	persistence: SettingsPersistence,
	provider: string,
	model: string | undefined,
): Promise<void> {
	return queueSelection(state, async () => {
		if (state.globalSettingsLoadError) throw state.globalSettingsLoadError;
		const previous = state.globalSettings.providerModels;
		const next = model === undefined ? { ...previous } : { ...previous, [provider]: model };
		if (model === undefined) delete next[provider];
		state.globalSettings.providerModels = next;
		persistence.markModified("providerModels", provider);
		const error = await persistence.save();
		if (!error) return;
		state.globalSettings.providerModels = previous;
		state.settings = effectiveSettings(state);
		throw error;
	});
}

/** Save shortcut selection through the same queue as defaults; a failed write keeps the prior saved selection. */
export function saveEnabledModels(
	state: SettingsState,
	persistence: SettingsPersistence,
	patterns: readonly string[] | undefined,
): Promise<void> {
	const snapshot = patterns ? [...patterns] : undefined;
	return queueSelection(state, async () => {
		if (state.globalSettingsLoadError) throw state.globalSettingsLoadError;
		const previous = state.globalSettings.enabledModels;
		if (snapshot) state.globalSettings.enabledModels = snapshot;
		else delete state.globalSettings.enabledModels;
		persistence.markModified("enabledModels");
		const error = await persistence.save();
		if (!error) return;
		if (state.globalSettings.enabledModels === snapshot) {
			if (previous) state.globalSettings.enabledModels = previous;
			else delete state.globalSettings.enabledModels;
		}
		state.settings = effectiveSettings(state);
		throw error;
	});
}

/** Commit all fields together; retain diagnostics and restore the attempted settings if storage fails. */
async function commitSelection(
	state: SettingsState,
	persistence: SettingsPersistence,
	provider: string,
	modelId: string | undefined,
	options: DefaultModelSelectionOptions,
): Promise<void> {
	if (state.globalSettingsLoadError) throw state.globalSettingsLoadError;
	const global = state.globalSettings;
	const previous = { ...global };
	const key = `${provider}/${modelId}`;
	const enabledModels = options.enabledModels && [...options.enabledModels];
	global.defaultProvider = provider;
	if (modelId === undefined) delete global.defaultModel;
	else global.defaultModel = modelId;
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
