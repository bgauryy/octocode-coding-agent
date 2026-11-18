import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { SettingsSchema } from "../core/settings-schema.ts";
import type { ConfigValueType } from "./types.ts";

/** One settings key a user can set: a leaf of `SettingsSchema`, named by its dotted path. */
export interface SettingLeaf {
	key: string;
	schema: TSchema;
	description?: string;
	default?: unknown;
	valueType: ConfigValueType;
}

/** Keys another kind owns: its adapter writes them with the owner's rules, so the generic writer refuses them. */
export const OWNED_SETTINGS: Readonly<Record<string, string>> = {
	defaultTools: "tool:<name>",
	toggles: "harness:<id>, plugin:<id> or hook:<id>",
	plugins: "plugin:<id>",
	marketplaces: "plugin:<id>",
	packages: "skill:, prompt: or theme:",
	skills: "skill:<name>",
	prompts: "prompt:<name>",
	themes: "theme:<name>",
	disabledProviders: "provider:<id>",
	"providerSources.pi": "source:pi",
	"providerSources.copilot-env": "source:copilot-env",
};

/** Keys the program writes for itself. */
const INTERNAL_SETTINGS = new Set(["$schema", "lastChangelogVersion", "trackingId", "deviceId"]);

type Node = TSchema & Record<string, unknown>;

function literals(schema: Node): string[] | undefined {
	if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) return schema.enum;
	const members = schema.anyOf as Node[] | undefined;
	if (!members?.length) return undefined;
	const values = members.map((member) => member.const);
	return values.every((value) => typeof value === "string") ? values : undefined;
}

function valueTypeOf(schema: Node): ConfigValueType {
	const values = literals(schema);
	if (values) return { type: "enum", values };
	if (schema.type === "boolean") return { type: "boolean" };
	if (schema.type === "number" || schema.type === "integer") return { type: "number" };
	if (schema.type === "string") return { type: "string" };
	return { type: "json" };
}

let cached: SettingLeaf[] | undefined;

/** Every settable leaf of `SettingsSchema`, nested sections flattened to dotted keys; objects without fixed keys stay JSON. */
export function settingLeaves(): SettingLeaf[] {
	if (cached) return cached;
	const leaves: SettingLeaf[] = [];
	const walk = (schema: Node, path: string): void => {
		const properties = schema.properties as Record<string, Node> | undefined;
		if (schema.type === "object" && properties && Object.keys(properties).length > 0) {
			for (const [name, child] of Object.entries(properties)) walk(child, path ? `${path}.${name}` : name);
			return;
		}
		if (!path || INTERNAL_SETTINGS.has(path)) return;
		leaves.push({
			key: path,
			schema,
			...(typeof schema.description === "string" ? { description: schema.description } : {}),
			...(schema.default !== undefined ? { default: schema.default } : {}),
			valueType: valueTypeOf(schema),
		});
	};
	walk(SettingsSchema as unknown as Node, "");
	cached = leaves;
	return leaves;
}

export const findLeaf = (key: string): SettingLeaf | undefined => settingLeaves().find((leaf) => leaf.key === key);

export type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Turn a CLI string into the leaf's value and validate it against its schema. JSON is tried first (`true`, `30`, `[1]`,
 * `{"a":1}`), then the raw text (an enum member, a path); the first that satisfies the schema wins. Typed values are checked as given.
 */
export function coerceSettingValue(leaf: SettingLeaf, input: unknown): Coerced {
	const candidates: unknown[] = [];
	if (typeof input === "string") {
		try {
			candidates.push(JSON.parse(input));
		} catch {
			// Not JSON: the raw text may still be the value.
		}
		candidates.push(input);
	} else candidates.push(input);
	const match = candidates.find((candidate) => Check(leaf.schema, candidate));
	if (match !== undefined) return { ok: true, value: match };
	const expected =
		leaf.valueType.type === "enum"
			? `one of ${leaf.valueType.values.join(", ")}`
			: leaf.valueType.type === "json"
				? (acceptedValues(leaf.schema) ?? "a value matching the settings schema (JSON)")
				: `a ${leaf.valueType.type}`;
	return { ok: false, reason: `Invalid value ${JSON.stringify(input)} for ${leaf.key}: expected ${expected}.` };
}

/** The literal values a union of literals and booleans accepts (`true|false|"auto"`), or undefined when the schema is not one. */
function acceptedValues(schema: unknown): string | undefined {
	const parts = (node: unknown): string[] | undefined => {
		if (typeof node !== "object" || node === null) return undefined;
		const record = node as { const?: unknown; type?: unknown; enum?: unknown[]; anyOf?: unknown[] };
		if ("const" in record) return [JSON.stringify(record.const)];
		if (record.type === "boolean") return ["true", "false"];
		if (Array.isArray(record.enum)) return record.enum.map((value) => JSON.stringify(value));
		if (Array.isArray(record.anyOf)) {
			const all = record.anyOf.map(parts);
			return all.every((part) => part !== undefined) ? all.flat() : undefined;
		}
		return undefined;
	};
	const values = parts(schema);
	return values ? `one of ${[...new Set(values)].join("|")}` : undefined;
}
