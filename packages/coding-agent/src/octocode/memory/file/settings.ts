import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import type { Settings } from "../../../core/settings-schema.ts";
import type { MemoryKind } from "../record.ts";

/** The `memory` settings with every default filled in; global and project files merged by the settings manager. */
export interface MemorySettings {
	file: boolean;
	autoUpdate: "off" | "explicit" | "auto";
	subagents: "workspace" | "all" | "none";
	recall: "off" | "main" | "all";
	reflection: boolean;
	subagentPinnedKind: MemoryKind;
}

export function memorySettings(settings: Pick<Settings, "memory"> | undefined): MemorySettings {
	return { ...SETTINGS_DEFAULTS.memory, ...settings?.memory };
}

/** Whether explicit saves (`memory set`, `/memory add`) write the MEMORY.md files. */
export const writesExplicit = (settings: MemorySettings): boolean => settings.file && settings.autoUpdate !== "off";

/** Whether the background passes (harvest, reflection, consolidation) may write the MEMORY.md files. */
export const writesAutomatically = (settings: MemorySettings): boolean =>
	settings.file && settings.autoUpdate === "auto";
