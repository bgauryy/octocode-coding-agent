import {
	type ProviderSourceId,
	type ProviderSourceOverrides,
	type ToggleableSourceId,
	TOGGLEABLE_SOURCE_IDS,
} from "./types.ts";

/** Defaults of the toggleable sources: Pi on, the Copilot variable off. */
export const SOURCE_DEFAULTS: Readonly<Record<ToggleableSourceId, boolean>> = { pi: true, "copilot-env": false };

/** Keep only known toggleable ids with boolean values, and only those that differ from the default. */
export function normalizeProviderSources(value: unknown): ProviderSourceOverrides {
	const result: ProviderSourceOverrides = {};
	if (typeof value !== "object" || value === null) return result;
	for (const id of TOGGLEABLE_SOURCE_IDS) {
		const entry = (value as Record<string, unknown>)[id];
		if (typeof entry === "boolean" && entry !== SOURCE_DEFAULTS[id]) result[id] = entry;
	}
	return result;
}

/** Whether a source is on, given the user's overrides. `octocode` is always on. */
export function isSourceEnabled(id: ProviderSourceId, overrides: ProviderSourceOverrides): boolean {
	if (id === "octocode") return true;
	return overrides[id] ?? SOURCE_DEFAULTS[id];
}

/**
 * The sources in effect for this process. Credential stores and provider auth read it when they resolve, so a change
 * followed by a runtime refresh applies at once. The setting is global, so one process has one answer.
 */
class ProviderSourceGate {
	private overrides: ProviderSourceOverrides = {};

	set(overrides: unknown): void {
		this.overrides = normalizeProviderSources(overrides);
	}

	get(): ProviderSourceOverrides {
		return { ...this.overrides };
	}

	isEnabled(id: ProviderSourceId): boolean {
		return isSourceEnabled(id, this.overrides);
	}
}

export const providerSourceGate = new ProviderSourceGate();
