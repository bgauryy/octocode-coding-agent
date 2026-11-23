/**
 * Coercions for two near misses models send often: a string that names an allowed value in the wrong case or number
 * (`tool` for `tools`), and one string where a list of strings is declared. Each applies only when the result is the
 * single value the schema allows, so a call that could mean two things still fails validation and names the field.
 */
import { inferSchemaTypes } from "./json-schema-shape.ts";

type Schema = { enum?: unknown; items?: unknown; type?: unknown };

const enumKey = (value: string) => value.toLowerCase().replace(/s$/, "");

/** The declared enum value `value` misspells by case or a trailing `s`, when exactly one matches; else `value`. */
export function nearestEnumValue(value: unknown, schema: Schema): unknown {
	if (typeof value !== "string" || !Array.isArray(schema.enum) || schema.enum.includes(value)) return value;
	const key = enumKey(value);
	const matches = schema.enum.filter((allowed) => typeof allowed === "string" && enumKey(allowed) === key);
	return matches.length === 1 ? matches[0] : value;
}

/** `[value]` for a lone string where the schema declares an array of strings; else `value`. */
export function loneStringItem(value: unknown, schema: Schema): unknown {
	if (typeof value !== "string" || !schema.items || typeof schema.items !== "object" || Array.isArray(schema.items))
		return value;
	const item = schema.items as Schema;
	return inferSchemaTypes(item).includes("string") ? [nearestEnumValue(value, item)] : value;
}
