/**
 * Tool parameter schema flavors for OpenAI-compatible endpoints.
 *
 * Moonshot (Kimi) endpoints validate `tools.function.parameters` against a stricter subset of
 * JSON Schema than the standard ("moonshot flavored json schema", MoonshotAI/kimi-cli#1595):
 * every property schema must define `type`, and beside `anyOf`/`oneOf` a `type` belongs on the
 * children, not the parent. Standard JSON Schema makes `type` optional, and real tool schemas
 * omit it routinely: a Zod literal becomes `{ "const": ... }`, an unconstrained field `{}`, and
 * MCP servers pass their `inputSchema` through as sent. Such tools are rejected with HTTP 400
 * before the model runs, so the repair below runs where the compat flavor is "moonshot".
 */

import type { TSchema } from "typebox";

/** Keys whose values map names to schemas; the map itself is not a schema node. */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/** Keys whose values are arrays of schema nodes. */
const SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Keys whose value is one nested schema. */
const SCHEMA_NODE_KEYS: ReadonlySet<string> = new Set([
	"items",
	"contains",
	"not",
	"additionalProperties",
	"propertyNames",
	"unevaluatedProperties",
	"if",
	"then",
	"else",
]);

/**
 * Boolean values for these keywords control schema extension rather than describing a value shape;
 * they are left as-is so standard `additionalProperties: false` semantics are preserved.
 */
const BOOLEAN_KEYWORD_VALUES: ReadonlySet<string> = new Set(["additionalProperties", "additionalItems"]);

function isSchemaObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string | undefined {
	switch (typeof value) {
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
			return Number.isInteger(value) ? "integer" : "number";
		case "object":
			if (value === null) return "null";
			return Array.isArray(value) ? "array" : "object";
		default:
			return undefined;
	}
}

/** `type` for a schema node that has none: from its keywords, else its `const`/`enum` values, else "string". */
function inferType(node: Record<string, unknown>): string {
	if ("properties" in node || "required" in node || "additionalProperties" in node) return "object";
	if ("items" in node || "prefixItems" in node) return "array";
	for (const key of ["const", "enum"] as const) {
		const value = node[key];
		if (value === undefined) continue;
		const samples = key === "const" ? [value] : Array.isArray(value) ? value : [];
		const types = new Set<string>();
		for (const sample of samples) {
			const type = jsonTypeOf(sample);
			if (type !== undefined) types.add(type);
		}
		// MoonshotAI/kimi-cli#2030: mixed const/enum values share no single JSON type, so fall back
		// to "string". The `enum` keyword is still validated independently, so valid values are not
		// narrowed.
		if (types.size === 1) return [...types][0];
		if (types.size > 1) return "string";
	}
	// An unconstrained or only-described node accepts anything; "string" is the safest scalar.
	return "string";
}

/**
 * MFJS cannot express boolean subschemas, including an exact `false`; both use its permissive object form.
 * The original schema remains authoritative for local argument validation (can1357/oh-my-pi#5955).
 */
function booleanSchemaObject(): Record<string, unknown> {
	return {};
}

function repairSchemaNode(value: unknown): unknown {
	if (typeof value === "boolean") return repairSchema(booleanSchemaObject());
	if (isSchemaObject(value)) return repairSchema(value);
	return value;
}

/**
 * One schema node with the Moonshot repairs applied. The input is never mutated; a node without
 * repairs still returns a copy, so callers can adjust the root afterwards.
 */
function repairSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const repaired: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		let next: unknown = value;
		if (SCHEMA_MAP_KEYS.has(key) && isSchemaObject(next)) {
			const map: Record<string, unknown> = {};
			for (const [name, subschema] of Object.entries(next)) {
				map[name] = repairSchemaNode(subschema);
			}
			next = map;
		} else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(next)) {
			next = next.map((item) => repairSchemaNode(item));
		} else if (SCHEMA_NODE_KEYS.has(key)) {
			if (BOOLEAN_KEYWORD_VALUES.has(key)) {
				// Leave boolean keyword values alone; repair only object subschemas.
				if (isSchemaObject(next)) next = repairSchema(next);
			} else {
				next = repairSchemaNode(next);
			}
		}
		repaired[key] = next;
	}
	// Beside a union the type belongs on its children (repaired above), never on the parent.
	if (Array.isArray(repaired.anyOf) || Array.isArray(repaired.oneOf)) {
		const { type: _parentType, ...withoutType } = repaired;
		return withoutType;
	}
	// A `$ref` node takes its type from the referenced definition, which is repaired on its own.
	if ("$ref" in repaired) return repaired;
	if (repaired.type === undefined || repaired.type === null) repaired.type = inferType(repaired);
	return repaired;
}

/**
 * Tool parameters as Moonshot's JSON Schema subset takes them. Non-object parameters become a
 * bare object schema. The root always stays an object, including beside a root union: Moonshot rejects a
 * root without `type: "object"` before it considers the branch-specific `anyOf` rule.
 */
export function sanitizeMoonshotToolParameters(parameters: TSchema): Record<string, unknown> {
	if (!isSchemaObject(parameters)) return { type: "object", properties: {} };
	const repaired = repairSchema(parameters);
	// The root is different from nested union parents: Moonshot requires its tool parameters to be an object.
	repaired.type = "object";
	if (repaired.properties === undefined) repaired.properties = {};
	return repaired;
}
