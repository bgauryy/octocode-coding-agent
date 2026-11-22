import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { SettingsSchema } from "../settings-schema.ts";

type ObjectSchema = { properties: Record<string, unknown>; additionalProperties?: unknown };

const KNOWN_KEYS = new Set(Object.keys(SettingsSchema.properties));

/** The object schema behind an optional property, or undefined when it is not a closed object with named properties. */
function objectSchema(schema: unknown): ObjectSchema | undefined {
	if (!isRecord(schema) || !isRecord(schema.properties) || schema.additionalProperties === true) return undefined;
	return schema as ObjectSchema;
}

function nestedIgnored(value: unknown, schema: unknown, prefix: string): string[] {
	const object = objectSchema(schema);
	if (!object || !isRecord(value)) return [];
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

/**
 * One line for every ignored key of a file: `2 ignored keys (thinkingBudgets.xhigh, compaction): /settings unset
 * thinkingBudgets.xhigh compaction`, or undefined when none. The command is the one-step fix; `--local` points it at
 * the project file.
 */
export function describeIgnoredKeys(
	keys: readonly string[],
	scope: "global" | "project" = "global",
): string | undefined {
	if (keys.length === 0) return undefined;
	const fix = `/settings unset ${keys.join(" ")}${scope === "project" ? " --local" : ""}`;
	return `${keys.length} ignored key${keys.length === 1 ? "" : "s"} (${keys.join(", ")}): ${fix}`;
}
