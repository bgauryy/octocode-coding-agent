import { SettingsSchema } from "../settings-schema.ts";

type ObjectSchema = { properties: Record<string, unknown>; additionalProperties?: unknown };

const KNOWN_KEYS = new Set(Object.keys(SettingsSchema.properties));

/** Root keys that earlier versions read and no setting controls now, each with what controls the behavior today. */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
	compaction:
		"Compaction is built in and its thresholds are fixed by the model's context window and thinking setup; no setting changes them.",
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object schema behind an optional property, or undefined when it is not a closed object with named properties. */
function objectSchema(schema: unknown): ObjectSchema | undefined {
	if (!isObject(schema) || !isObject(schema.properties) || schema.additionalProperties === true) return undefined;
	return schema as ObjectSchema;
}

function nestedIgnored(value: unknown, schema: unknown, prefix: string): string[] {
	const object = objectSchema(schema);
	if (!object || !isObject(value)) return [];
	return Object.keys(value).flatMap((key) =>
		key in object.properties
			? nestedIgnored(value[key], object.properties[key], `${prefix}.${key}`)
			: [`${prefix}.${key}`],
	);
}

/**
 * Keys of a loaded settings object that Octocode does not read, in file order: unknown root keys, and unknown keys
 * inside a known object setting (as a dotted path such as `thinkingBudgets.xhigh`).
 */
export function ignoredSettingsKeys(settings: object): string[] {
	const properties = SettingsSchema.properties as Record<string, unknown>;
	return Object.entries(settings).flatMap(([key, value]) =>
		KNOWN_KEYS.has(key) ? nestedIgnored(value, properties[key], key) : [key],
	);
}

/** One sentence naming an ignored key: a removed key says what controls it now, any other says to check the spelling. */
export function describeIgnoredKey(key: string): string {
	const removed = Object.hasOwn(REMOVED_KEYS, key) ? REMOVED_KEYS[key] : undefined;
	if (removed) return `Setting "${key}" was removed, so it does nothing. ${removed} Delete it from the file.`;
	return `Setting "${key}" is not a known setting, so it does nothing. Check the spelling, or delete it from the file.`;
}
