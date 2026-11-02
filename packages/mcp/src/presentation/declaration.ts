import { inferSchemaTypes, liftedProperties, resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import type { TSchema } from "typebox";

type Schema = Record<string, unknown>;

/** The declared parameters of a thin MCP tool with no readable top level: any object. */
const THIN_PARAMETERS = { type: "object", additionalProperties: true } as unknown as TSchema;

const JSON_TYPES = new Set(["array", "object", "string", "number", "integer", "boolean", "null"]);

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether the server's schema declares a `reason` argument anywhere at its top level (its root, a root alternative or a
 * root `$ref` target, as the shared lift lists them), so the host must keep it.
 */
export const declaresReason = (inputSchema: unknown): boolean => Object.hasOwn(liftedProperties(inputSchema), "reason");

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

/** A property's thin schema: its one type, an `anyOf` of its types, or `{}` (any value) when a type is unknown. */
function thinProperty(schema: unknown, root: unknown): Schema {
	const types = propertyTypes(schema, root, new Set());
	if (types === undefined) return {};
	return types.length === 1 ? { type: types[0] } : { anyOf: types.map((type) => ({ type })) };
}

/**
 * The declared parameters of a thin MCP tool: each top-level field with only its JSON type, open otherwise. Without
 * the top-level types, models send arrays and objects as JSON strings. A field whose alternatives differ declares each
 * type, and one whose type is unknown declares none; neither is narrowed nor dropped. This approximates the shape for
 * the declaration only (keys and top types, never narrower than the schema), not JSON Schema validation: the host
 * validates every call against the server's own schema (`validationParameters`) and the generated file carries the
 * full shape.
 */
export function thinParameters(inputSchema: unknown): TSchema {
	// Object.fromEntries defines own properties, so a field named `__proto__` or `constructor` keeps its own type.
	const properties: Record<string, Schema> = Object.fromEntries(
		Object.entries(liftedProperties(inputSchema)).map(([key, value]) => [key, thinProperty(value, inputSchema)]),
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
