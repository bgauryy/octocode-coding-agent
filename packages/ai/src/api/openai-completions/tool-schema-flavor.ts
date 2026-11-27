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
import { liftRootComposition } from "../../utils/json-schema-shape.ts";

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

/** MFJS accepts string and numeric enum values. Keep mixed choices in typed branches.
 * The host validates exact boolean, null and structured choices against the server schema.
 */
function projectEnum(schema: Record<string, unknown>, values: unknown[]): Record<string, unknown> {
	const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
	if (schema.type === "string" && values.every((v) => typeof v === "string")) return schema;
	if (schema.type === "integer" && values.every(Number.isInteger)) return schema;
	if (schema.type === "number" && values.every((v) => typeof v === "number")) return schema;
	const groups = new Map<string, unknown[]>();
	for (const value of values) {
		const type = typeof value === "number" ? "number" : jsonTypeOf(value);
		if (
			!type ||
			(declared.length && !declared.includes(type) && !(Number.isInteger(value) && declared.includes("integer")))
		)
			continue;
		const group = groups.get(type);
		if (group) group.push(value);
		else groups.set(type, [value]);
	}
	const { enum: _enum, type: _type, description, ...constraints } = schema;
	// A contradictory declaration has no legal value. Keep the enclosing tool usable; execution still rejects it.
	if (groups.size === 0)
		return {
			...constraints,
			...(description === undefined ? {} : { description }),
			type: typeof schema.type === "string" ? schema.type : "string",
		};
	const branches = Array.from(groups, ([kind, members]) => ({
		...constraints,
		type: kind === "number" && members.every(Number.isInteger) ? "integer" : kind,
		...(kind === "number" || kind === "string" ? { enum: members } : {}),
		...(kind === "boolean" && members.length === 1
			? { description: [description, `Allowed value: ${String(members[0])}.`].filter(Boolean).join(" ") }
			: {}),
	}));
	return {
		...(description === undefined ? {} : { description }),
		...(branches.length === 1 ? branches[0] : { anyOf: branches }),
	};
}

/** Infer the type when the caller supplied no explicit type or enum. */
function inferType(node: Record<string, unknown>): string {
	if ("properties" in node || "required" in node || "additionalProperties" in node) return "object";
	if ("items" in node || "prefixItems" in node) return "array";
	return jsonTypeOf(node.const) ?? "string";
}

/**
 * MFJS cannot express boolean subschemas, including an exact `false`; both use its permissive object form.
 * The original schema remains authoritative for local argument validation.
 */
function booleanSchemaObject(): Record<string, unknown> {
	return {};
}

/** The root's definitions, by the `#/$defs/<name>` or `#/definitions/<name>` pointer that names them. */
type Definitions = ReadonlyMap<string, unknown>;

function rootDefinitions(root: Record<string, unknown>): Definitions {
	const definitions = new Map<string, unknown>();
	for (const key of ["$defs", "definitions"] as const) {
		const map = root[key];
		if (!isSchemaObject(map)) continue;
		for (const [name, schema] of Object.entries(map)) definitions.set(`#/${key}/${name}`, schema);
	}
	return definitions;
}

/**
 * Moonshot rejects `$ref` under `propertyNames` ("$ref is not allowed"), so a local reference there is replaced by the
 * definition it names, following chained references. An unresolvable one drops the keyword: it only narrows key names,
 * and the original schema stays authoritative for local argument validation.
 */
function inlinePropertyNames(value: unknown, definitions: Definitions): unknown {
	const seen = new Set<string>();
	let node = value;
	while (isSchemaObject(node) && typeof node.$ref === "string") {
		if (seen.has(node.$ref) || !definitions.has(node.$ref)) return undefined;
		seen.add(node.$ref);
		const { $ref, ...siblings } = node;
		const target = definitions.get($ref);
		node = isSchemaObject(target) ? { ...target, ...siblings } : target;
	}
	return repairSchemaNode(node, definitions);
}

function repairSchemaNode(value: unknown, definitions: Definitions): unknown {
	if (typeof value === "boolean") return repairSchema(booleanSchemaObject(), definitions);
	if (isSchemaObject(value)) return repairSchema(value, definitions);
	return value;
}

/** A choice of required fields draws its types from the enclosing object. MFJS needs a self-contained
 * object at that position. The presented fields stay typed, and local validation enforces the choice.
 */
function presenceAlternatives(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(branch) =>
				isSchemaObject(branch) &&
				Array.isArray(branch.required) &&
				Object.keys(branch).every((key) => key === "required" || (key === "type" && branch.type === "object")),
		)
	);
}

/**
 * One schema node with the Moonshot repairs applied. The input is never mutated; a node without
 * repairs still returns a copy, so callers can adjust the root afterwards.
 */
function repairSchema(schema: Record<string, unknown>, definitions: Definitions): Record<string, unknown> {
	// Collected as entries: `Object.fromEntries` defines own properties, so a name such as `__proto__` stays a name.
	const entries: [string, unknown][] = [];
	const source =
		isSchemaObject(schema.properties) && (presenceAlternatives(schema.oneOf) || presenceAlternatives(schema.anyOf))
			? liftRootComposition(schema)
			: schema;
	for (const [key, value] of Object.entries(source)) {
		if (key === "oneOf" && Array.isArray(source.anyOf)) continue;
		let next: unknown = value;
		if (SCHEMA_MAP_KEYS.has(key) && isSchemaObject(next)) {
			next = Object.fromEntries(
				Object.entries(next).map(([name, subschema]) => [name, repairSchemaNode(subschema, definitions)]),
			);
		} else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(next)) {
			next = next.map((item) => repairSchemaNode(item, definitions));
		} else if (key === "propertyNames") {
			next = inlinePropertyNames(next, definitions);
			if (next === undefined) continue;
		} else if (SCHEMA_NODE_KEYS.has(key)) {
			if (BOOLEAN_KEYWORD_VALUES.has(key)) {
				// Leave boolean keyword values alone; repair only object subschemas.
				if (isSchemaObject(next)) next = repairSchema(next, definitions);
			} else {
				next = repairSchemaNode(next, definitions);
			}
		}
		// The model can choose any alternative. The host checks the source schema for exclusivity.
		entries.push([key === "oneOf" ? "anyOf" : key, next]);
	}
	const repaired: Record<string, unknown> = Object.fromEntries(entries);
	// Beside a union the type belongs on its children (repaired above), never on the parent.
	if (Array.isArray(repaired.anyOf)) {
		const { type: _parentType, ...withoutType } = repaired;
		return withoutType;
	}
	// A `$ref` node takes its type from the referenced definition, which is repaired on its own (`propertyNames` aside).
	if ("$ref" in repaired) return repaired;
	if (repaired.const === undefined && Array.isArray(repaired.enum) && repaired.enum.length)
		return projectEnum(repaired, repaired.enum);
	repaired.type ??= inferType(repaired);
	if (typeof repaired.const === "string" || typeof repaired.const === "number") {
		const { const: literal, ...rest } = repaired;
		return { ...rest, enum: Array.isArray(rest.enum) ? rest.enum.filter((v) => v === literal) : [literal] };
	}
	return repaired;
}

/**
 * Tool parameters as Moonshot's JSON Schema subset takes them. Non-object parameters become a
 * bare object schema. The root always stays an object, with root alternatives projected into its named fields.
 */
export function sanitizeMoonshotToolParameters(parameters: TSchema): Record<string, unknown> {
	if (!isSchemaObject(parameters)) return { type: "object", properties: {} };
	const repaired = repairSchema(liftRootComposition(parameters), rootDefinitions(parameters));
	// Moonshot requires an object at the tool root.
	repaired.type = "object";
	if (repaired.properties === undefined) repaired.properties = {};
	return repaired;
}
