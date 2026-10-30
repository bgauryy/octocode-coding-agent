import { mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { parseHttpIdleTimeoutMs } from "../http-dispatcher.ts";
import type { Settings } from "../settings-schema.ts";
import { mergeToggles } from "../extensibility/toggles.ts";
import { mergeDefaultTools } from "./tool-list.ts";

export function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeObjects(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
export function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const merged = deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
	Object.assign(
		merged,
		mergeCachePreferences([
			{ source: "base", values: base },
			{ source: "override", values: overrides },
		]).options,
	);
	const defaultTools = mergeDefaultTools(base.defaultTools, overrides.defaultTools);
	return defaultTools === undefined ? merged : { ...merged, defaultTools };
}

export function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return undefined;
}

/**
 * Global settings overlaid by trusted project settings; project `toggles` keys keep their scope (see `mergeToggles`).
 * `remote.autoStart` publishes this machine to another device, so a project file may only turn it off: the global
 * value stands unless the project says "off".
 */
export function mergeScopedSettings(global: Settings, project: Settings): Settings {
	const merged = deepMergeSettings(global, project);
	const toggles = mergeToggles(global.toggles, project.toggles);
	const result = toggles === undefined ? merged : { ...merged, toggles };
	if (project.remote?.autoStart !== undefined && project.remote.autoStart !== "off") {
		const autoStart = global.remote?.autoStart;
		result.remote = { ...result.remote, ...(autoStart === undefined ? {} : { autoStart }) };
		if (autoStart === undefined) delete result.remote.autoStart;
	}
	return result;
}
