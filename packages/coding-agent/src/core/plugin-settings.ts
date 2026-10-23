import { Check } from "typebox/value";
import { SettingsSchema } from "./settings-schema.ts";
import type { Settings } from "./settings-manager.ts";

/** Settings files are untrusted JSON; validate each plugin before discovery. */
export function configuredPlugins(value: unknown, report: (message: string) => void): NonNullable<Settings["plugins"]> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		report("plugins must be an array");
		return [];
	}
	return value.flatMap((entry, index) => {
		if (Check(SettingsSchema.properties.plugins.items, entry)) return [entry];
		report(`plugins[${index}] does not match the plugin settings schema; skipped`);
		return [];
	});
}
