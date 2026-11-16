import { Value } from "typebox/value";
import { stripBom } from "@octocodeai/octocode-common/text";
import type { Settings } from "../settings-schema.ts";
import { ModelAvailabilitySettingsProperties } from "../settings-schema/model-availability.ts";
import { isMergeableObject } from "./merge.ts";
import type { SettingsScope, SettingsStorage } from "./storage.ts";

function loadSettingsFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = false): Settings {
	if (scope === "project" && !projectTrusted) {
		return {};
	}

	let content: string | undefined;
	storage.withLock(
		scope,
		(current) => {
			content = current;
			return undefined;
		},
		{ readOnly: true },
	);

	if (content === undefined) {
		return {};
	}
	const settings = settingsObject(JSON.parse(stripBom(content)));
	if (
		scope === "global" &&
		settings.disabledProviders !== undefined &&
		!Value.Check(ModelAvailabilitySettingsProperties.disabledProviders, settings.disabledProviders)
	) {
		throw new Error("Invalid disabledProviders setting: expected an array of provider IDs");
	}
	return settings;
}

export function tryLoadSettingsFromStorage(
	storage: SettingsStorage,
	scope: SettingsScope,
	projectTrusted = false,
): { settings: Settings; error: Error | null } {
	try {
		return { settings: loadSettingsFromStorage(storage, scope, projectTrusted), error: null };
	} catch (error) {
		return { settings: {}, error: error as Error };
	}
}

/** `settings` as a settings object; anything else (an array, a string) is refused. Keys are never renamed or converted. */
export function settingsObject(settings: Record<string, unknown>): Settings {
	if (!isMergeableObject(settings)) throw new Error("Invalid settings object: expected a JSON object");
	return settings;
}
