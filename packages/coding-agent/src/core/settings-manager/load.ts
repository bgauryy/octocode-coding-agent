import { stripBom } from "../../utils/text.ts";
import type { Settings } from "../settings-schema.ts";
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
	const settings = JSON.parse(stripBom(content));
	return migrateSettings(settings);
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

/** Migrate old settings format to new format */
export function migrateSettings(settings: Record<string, unknown>): Settings {
	if (!isMergeableObject(settings)) throw new Error("Invalid settings object: expected a JSON object");
	// Migrate queueMode -> steeringMode
	if ("queueMode" in settings && !("steeringMode" in settings)) {
		settings.steeringMode = settings.queueMode;
		delete settings.queueMode;
	}

	// Migrate legacy websockets boolean -> transport enum
	if (!("transport" in settings) && typeof settings.websockets === "boolean") {
		settings.transport = settings.websockets ? "websocket" : "sse";
		delete settings.websockets;
	}

	// Migrate old skills object format to new array format
	if (
		"skills" in settings &&
		typeof settings.skills === "object" &&
		settings.skills !== null &&
		!Array.isArray(settings.skills)
	) {
		const skillsSettings = settings.skills as {
			enableSkillCommands?: boolean;
			customDirectories?: unknown;
		};
		if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
			settings.enableSkillCommands = skillsSettings.enableSkillCommands;
		}
		if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
			settings.skills = skillsSettings.customDirectories;
		} else {
			delete settings.skills;
		}
	}

	// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
	if (
		"retry" in settings &&
		typeof settings.retry === "object" &&
		settings.retry !== null &&
		!Array.isArray(settings.retry)
	) {
		const retrySettings = settings.retry as Record<string, unknown>;
		const providerSettings =
			typeof retrySettings.provider === "object" && retrySettings.provider !== null
				? (retrySettings.provider as Record<string, unknown>)
				: undefined;
		if (
			typeof retrySettings.maxDelayMs === "number" &&
			(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
		) {
			retrySettings.provider = {
				...providerSettings,
				maxRetryDelayMs: retrySettings.maxDelayMs,
			};
		}
		delete retrySettings.maxDelayMs;
	}

	return settings;
}
