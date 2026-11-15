import { inferSchemaTypes, liftedProperties, resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import type { TSchema } from "typebox";

type Schema = Record<string, unknown>;

/** The declared parameters of a thin MCP tool with no readable top level: any object. */
const THIN_PARAMETERS = { type: "object", additionalProperties: true } as unknown as TSchema;

const JSON_TYPES = new Set(["array", "object", "string", "number", "integer", "boolean", "null"]);

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON types a property accepts, in branch order: its own `type` (or the type `properties`/`items` imply), else the
 * union of its `anyOf`/`oneOf` branches. Undefined when any part is unknown (no type, `allOf`, an unresolvable or
 * cyclic `$ref`), so the caller declares no type rather than a narrower one.
 */
function propertyTypes(schema: unknown, root: unknown, seen: Set<unknown>): string[] | undefined {
	const node = resolveLocalRef(schema, root);
	if (!isSchema(node)) return undefined;
	const own = inferSchemaTypes(node);
	if (own.length > 0) return own.every((type) => JSON_TYPES.has(type)) ? [...new Set(own)] : undefined;
	const branches = node.anyOf ?? node.oneOf;
	// A branch list already being read is a cycle; it adds no type that is known.
	if (!Array.isArray(branches) || branches.length === 0 || seen.has(branches)) return undefined;
	const inner = new Set([...seen, branches]);
	const types: string[] = [];
	for (const branch of branches) {
		const next = propertyTypes(branch, root, inner);
		if (next === undefined) return undefined;
		for (const type of next) if (!types.includes(type)) types.push(type);
	}
	return types.length > 0 ? types : undefined;
}

/**
 * The most field names a thin declaration lists for one nested object; required fields come first, then the server's
 * order. The object stays open, so a field past the cap is still accepted; the generated file lists every field.
 */
const THIN_NESTED_NAMES = 32;

/** The node a single-type `object` or `array` property names its fields through: itself, or its array items. */
function fieldsNode(schema: unknown, root: unknown, type: string): unknown {
	const node = resolveLocalRef(schema, root);
	if (!isSchema(node)) return undefined;
	if (type === "object") return node;
	if (type !== "array" || !isSchema(node.items)) return undefined;
	const items = propertyTypes(node.items, root, new Set());
	return items?.length === 1 && items[0] === "object" ? node.items : undefined;
}

/** The field names an object node requires (after a local `$ref`), listed first under the cap. */
function requiredNames(node: unknown, root: unknown): Set<string> {
	const resolved = resolveLocalRef(node, root);
	const required = isSchema(resolved) && Array.isArray(resolved.required) ? resolved.required : [];
	return new Set(required.filter((name): name is string => typeof name === "string"));
}

/**
 * The fields of a nested object, each thin, at most {@link THIN_NESTED_NAMES}; undefined when it lists none. Field
 * names and JSON types are schema facts; no description, enum or bound is copied.
 */
function nestedFields(node: unknown, root: unknown, level: number): Record<string, Schema> | undefined {
	const entries = Object.entries(liftedProperties(node, root));
	if (entries.length === 0) return undefined;
	const required = requiredNames(node, root);
	const ordered = [
		...entries.filter(([key]) => required.has(key)),
		...entries.filter(([key]) => !required.has(key)),
	].slice(0, THIN_NESTED_NAMES);
	// Object.fromEntries defines own properties, so a field named `__proto__` or `constructor` keeps its own type.
	return Object.fromEntries(ordered.map(([key, value]) => [key, thinProperty(value, root, level)]));
}

/**
 * A property's thin schema: its one type, an `anyOf` of its types, or `{}` (any value) when a type is unknown. A
 * top-level field that is an object, or an array of objects, also names its fields with their thin schemas; in that
 * level, a field that is an array of objects names its items' fields too (`queries[].ranges[].startLine`), a nested
 * plain object only its type. Without these names a model sees `queries: array` and cannot name a field such as
 * `startLine` before reading the schema. Nothing becomes required and each object stays open, so the declaration is
 * never narrower than the server's.
 */
function thinProperty(schema: unknown, root: unknown, level: number): Schema {
	const types = propertyTypes(schema, root, new Set());
	if (types === undefined) return {};
	if (types.length > 1) return { anyOf: types.map((type) => ({ type })) };
	const [type] = types;
	const names = level === 0 || (level === 1 && type === "array");
	const node = names ? fieldsNode(schema, root, type) : undefined;
	const properties = node === undefined ? undefined : nestedFields(node, root, level + 1);
	if (properties === undefined) return { type };
	const object = { type: "object", properties, additionalProperties: true };
	return type === "object" ? object : { type, items: object };
}

/**
 * The declared parameters of a thin MCP tool: each top-level field with its JSON type, open otherwise. Without the
 * top-level types, models send arrays and objects as JSON strings. A field whose alternatives differ declares each
 * type, and one whose type is unknown declares none; neither is narrowed nor dropped. Nested objects name their fields
 * as `thinProperty` says, unless `nested` is false (a native tool, whose own description names its fields). This approximates the shape for the declaration only (keys and types, never narrower than the
 * schema), not JSON Schema validation: the host validates every call against the server's own schema
 * (`validationParameters`) and the generated file carries the full shape.
 */
export function thinParameters(inputSchema: unknown, { nested = true }: { nested?: boolean } = {}): TSchema {
	// Past the last level `thinProperty` names, a field declares only its type.
	const level = nested ? 0 : 2;
	// Object.fromEntries defines own properties, so a field named `__proto__` or `constructor` keeps its own type.
	const properties: Record<string, Schema> = Object.fromEntries(
		Object.entries(liftedProperties(inputSchema)).map(([key, value]) => [key, thinProperty(value, inputSchema, level)]),
	);
	if (!Object.keys(properties).length) return THIN_PARAMETERS;
	const thin: TSchema = { type: "object", properties, additionalProperties: true };
	return thin;
}

/**
 * The first sentence of a tool description, whole and on one line: the summary a thin declaration carries when the
 * tool has no authored trigger. The generated file keeps the full description.
 */
export function firstSentence(description: string): string {
	// Servers wrap parts of a description in tags such as <when>; they carry no meaning in a one-line summary.
	const text = description
		.replace(/<\/?[a-z][\w-]*>/gi, " ")
		.trim()
		.replace(/\s+/g, " ");
	const end = /[.!?](?=\s|$)/.exec(text);
	return end ? text.slice(0, end.index + 1) : text;
}
