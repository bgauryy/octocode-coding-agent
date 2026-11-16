import { getFileRevision } from "@octocodeai/octocode-common/paths";
import { watchFileChanges } from "@octocodeai/octocode-common/watch-file";
import { normalizeProviderSources } from "../provider-sources/gate.ts";
import { tryLoadSettingsFromStorage } from "./load.ts";
import { effectiveSettings } from "./merge.ts";
import type { SettingsState } from "./state.ts";

function toggles(settings: { disabledProviders?: string[]; providerSources?: unknown }): string {
	return JSON.stringify([
		[...new Set(settings.disabledProviders)].sort((a, b) => a.localeCompare(b)),
		Object.entries(normalizeProviderSources(settings.providerSources)).sort(([a], [b]) => a.localeCompare(b)),
	]);
}

/**
 * Adopt `disabledProviders` and `providerSources` from the global file when they differ from memory, leaving every
 * other setting and every unsaved change untouched. Returns whether anything changed; a file that does not parse changes nothing.
 */
function adoptProviderToggles(state: SettingsState): boolean {
	const load = tryLoadSettingsFromStorage(state.storage, "global");
	if (load.error || toggles(load.settings) === toggles(state.globalSettings)) return false;
	state.globalSettings.disabledProviders = load.settings.disabledProviders;
	state.globalSettings.providerSources = load.settings.providerSources;
	state.settings = effectiveSettings(state);
	return true;
}

/**
 * Calls `onChange` after another process saved a different `disabledProviders` or `providerSources` to the global
 * settings file. A file-system watcher on its folder sees the save (`intervalMs` paces the stat polling only where that
 * watcher fails), never keeping the process alive; this process's own saves already match memory and call nothing.
 * Returns the stop function.
 */
export function watchProviderToggles(state: SettingsState, onChange: () => void, intervalMs = 1000): () => void {
	const path = state.settingsPaths.global;
	if (!path) return () => {};
	let seen = getFileRevision(path);
	return watchFileChanges(
		path,
		() => {
			const revision = getFileRevision(path);
			if (revision === seen) return;
			seen = revision;
			if (adoptProviderToggles(state)) onChange();
		},
		{ intervalMs },
	);
}
