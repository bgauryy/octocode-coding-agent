import { inferSchemaTypes, liftedProperties, resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import type { TSchema } from "typebox";

type Schema = Record<string, unknown>;

/** The declared parameters of a thin MCP tool with no readable top level: any object. */
const THIN_PARAMETERS = { type: "object", additionalProperties: true } as unknown as TSchema;

const JSON_TYPES = new Set(["array", "object", "string", "number", "integer", "boolean", "null"]);

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type Primitive = string | number | boolean | null;
const isPrimitive = (value: unknown): value is Primitive =>
	value === null || ["string", "number", "boolean"].includes(typeof value);
const jsonType = (value: Primitive): string => (value === null ? "null" : typeof value);

/** The values an `enum` or `const` names, when every one is a primitive. */
function listedValues(node: Schema): Primitive[] | undefined {
	const values = Array.isArray(node.enum) ? node.enum : node.const !== undefined ? [node.const] : undefined;
	return values && values.length > 0 && values.every(isPrimitive) ? values : undefined;
}

/**
 * The JSON types a property accepts, in branch order: its own `type` (or the type `properties`/`items` imply, or the
 * types of the values its `enum` or `const` names), else the union of its `anyOf`/`oneOf` branches. Undefined when any
 * part is unknown (no type, `allOf`, an unresolvable or cyclic `$ref`), so the caller declares no type rather than a
 * narrower one.
 */
function propertyTypes(schema: unknown, root: unknown, seen: Set<unknown>): string[] | undefined {
	const node = resolveLocalRef(schema, root);
	if (!isSchema(node)) return undefined;
	const own = inferSchemaTypes(node);
	if (own.length > 0) return own.every((type) => JSON_TYPES.has(type)) ? [...new Set(own)] : undefined;
	const values = listedValues(node);
	if (values) return [...new Set(values.map(jsonType))];
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
	if (type !== "array" || node.prefixItems !== undefined || !isSchema(node.items)) return undefined;
	const items = propertyTypes(node.items, root, new Set());
	return items?.length === 1 && items[0] === "object" ? node.items : undefined;
}

/** A thin object can advertise a closed key set only if the server closes it and allows no pattern keys. */
function allowsOtherFields(schema: unknown, root: unknown): boolean {
	const node = resolveLocalRef(schema, root);
	return !isSchema(node) || node.additionalProperties !== false || node.patternProperties !== undefined;
}

/** The field names an object node requires (after a local `$ref`), listed first under the cap. */
function requiredNames(node: unknown, root: unknown): Set<string> {
	const resolved = resolveLocalRef(node, root);
	const required = isSchema(resolved) && Array.isArray(resolved.required) ? resolved.required : [];
	return new Set(required.filter((name): name is string => typeof name === "string"));
}

/**
 * An object node's thin form, open when truncated: the fields it lists, each thin, at most
 * {@link THIN_NESTED_NAMES}, and the listed ones it requires. Undefined when it lists none.
 */
function thinObject(node: unknown, root: unknown, level: number): Schema | undefined {
	const entries = Object.entries(liftedProperties(node, root));
	if (entries.length === 0) return undefined;
	const required = requiredNames(node, root);
	const ordered = [
		...entries.filter(([key]) => required.has(key)),
		...entries.filter(([key]) => !required.has(key)),
	].slice(0, THIN_NESTED_NAMES);
	// Object.fromEntries defines own properties, so a field named `__proto__` or `constructor` keeps its own type.
	const properties = Object.fromEntries(ordered.map(([key, value]) => [key, thinProperty(value, root, level)]));
	const listed = ordered.flatMap(([key]) => (required.has(key) ? [key] : []));
	const complete = ordered.length === entries.length;
	return {
		type: "object",
		properties,
		additionalProperties: !complete || allowsOtherFields(node, root),
		...(listed.length > 0 ? { required: listed } : {}),
	};
}

/** The most serialized characters a thin declaration spends on a field's permitted values. */
const THIN_ENUM_CHARS = 240;

/**
 * The values a field allows when it names them all: its `enum`, its `const`, or the values of every alternative
 * (`anyOf`/`oneOf` of constants, as a union of literals is written). Undefined when any part allows other values.
 */
function allowedValues(schema: unknown, root: unknown, seen: Set<unknown>): Primitive[] | undefined {
	const node = resolveLocalRef(schema, root);
	if (!isSchema(node)) return undefined;
	if (node.enum !== undefined || node.const !== undefined) return listedValues(node);
	const branches = node.anyOf ?? node.oneOf;
	if (!Array.isArray(branches) || branches.length === 0 || seen.has(branches)) return undefined;
	const inner = new Set([...seen, branches]);
	const values: Primitive[] = [];
	for (const branch of branches) {
		const next = allowedValues(branch, root, inner);
		if (next === undefined) return undefined;
		for (const value of next) if (!values.includes(value)) values.push(value);
	}
	return values;
}

/** A field's allowed values when they are few and short, as `enum` with their one JSON type when they share one. */
function shortEnum(schema: unknown, root: unknown, types: readonly string[] | undefined): Schema | undefined {
	const values = allowedValues(schema, root, new Set());
	if (!values || values.length > THIN_ENUM_CHARS || JSON.stringify(values).length > THIN_ENUM_CHARS) return undefined;
	const kinds = new Set(values.map(jsonType));
	const type = types?.length === 1 ? types[0] : kinds.size === 1 ? [...kinds][0] : undefined;
	return { ...(type ? { type } : {}), enum: values };
}

/** An array node's `minItems` and `maxItems`, and its items' allowed values when they are few (`shortEnum`). */
function arrayFacts(schema: unknown, root: unknown, withItems: boolean): Schema {
	const node = resolveLocalRef(schema, root);
	if (!isSchema(node)) return {};
	const bound = (value: unknown) => (Number.isInteger(value) ? value : undefined);
	const types = withItems && node.prefixItems === undefined ? propertyTypes(node.items, root, new Set()) : undefined;
	const itemType = types?.length === 1 ? types[0] : undefined;
	const items =
		withItems && node.prefixItems === undefined
			? (shortEnum(node.items, root, types) ??
				(itemType && itemType !== "object" && itemType !== "array" ? { type: itemType } : undefined))
			: undefined;
	return {
		...(bound(node.minItems) === undefined ? {} : { minItems: node.minItems }),
		...(bound(node.maxItems) === undefined ? {} : { maxItems: node.maxItems }),
		...(items ? { items } : {}),
	};
}

/**
 * A property's thin schema: its one type, an `anyOf` of its types, or `{}` (any value) when a type is unknown; the
 * values it allows when it names a few (`enum`, `const`, a union of constants), so an enum-only field is never `{}`;
 * and an array's item bounds. A top-level field that is an object, or an array of objects, also names its fields with
 * their thin schemas and the ones it requires; in that level, a field that is an array of objects names its items'
 * fields too (`queries[].ranges[].startLine`), a nested plain object only its type. Without these names a model sees
 * `queries: array` and cannot name a field such as `startLine` before reading the schema. Descriptions and other
 * bounds stay out, and truncated or pattern-keyed objects stay open.
 */
function thinProperty(schema: unknown, root: unknown, level: number): Schema {
	const types = propertyTypes(schema, root, new Set());
	const values = shortEnum(schema, root, types);
	if (values) return values;
	if (types === undefined) return {};
	if (types.length > 1) return { anyOf: types.map((type) => ({ type })) };
	const [type] = types;
	const names = level === 0 || (level === 1 && type === "array");
	const node = names ? fieldsNode(schema, root, type) : undefined;
	const object = node === undefined ? undefined : thinObject(node, root, level + 1);
	if (type === "object") return object ?? { type };
	if (type !== "array") return { type };
	return { type, ...arrayFacts(schema, root, object === undefined), ...(object ? { items: object } : {}) };
}

/**
 * The declared parameters of a thin tool: each top-level field with its JSON type (and the few values it allows, and
 * an array's item bounds), the top-level fields the schema requires, open otherwise. Without the top-level types,
 * models send arrays and objects as JSON strings; without the values and bounds they guess an operation name or send
 * one query too many. A field whose alternatives differ declares each type, and one whose type is unknown declares none;
 * neither is narrowed nor dropped. Nested objects name their fields as `thinProperty` says, unless `nested` is false (a
 * native tool, whose own description names its fields). This approximates the shape for the declaration only (never
 * narrower than the schema), not JSON Schema validation: the host validates every call against the tool's own schema
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
	const required = [...requiredNames(inputSchema, inputSchema)].filter((key) => Object.hasOwn(properties, key));
	const thin: TSchema = {
		type: "object",
		properties,
		additionalProperties: true,
		...(required.length > 0 ? { required } : {}),
	};
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
