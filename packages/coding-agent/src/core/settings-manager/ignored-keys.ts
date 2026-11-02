import { SettingsSchema } from "../settings-schema.ts";

const KNOWN_KEYS = new Set(Object.keys(SettingsSchema.properties));

/** Root keys of a loaded settings object that Octocode does not read, in file order. */
export function ignoredSettingsKeys(settings: object): string[] {
	return Object.keys(settings).filter((key) => !KNOWN_KEYS.has(key));
}

/** One sentence naming an ignored key. */
export function describeIgnoredKey(key: string): string {
	return `Setting "${key}" is not a known setting, so it does nothing. Check the spelling, or delete it from the file.`;
}
