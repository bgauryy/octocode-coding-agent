import { isNode, type Node } from "./schema-nodes.ts";
import type { JsonSchema } from "./types.ts";

/**
 * A definition this short is written where it is used: naming it costs a `type` line and a name at each use, more than
 * the text itself. Servers that emit one definition per distinct sub-schema (zod's `$defs: { 0, 1, ... }`) send many.
 */
const TINY_DEFINITION_CHARS = 160;

const DEFINITION = /^#\/\$defs\/([^/]+)$/;

/**
 * `schema` with each reference to a tiny definition replaced by the definition's keywords (the reference's own siblings
 * win, as when it is resolved). Definitions that hold object properties, or that refer to themselves, stay named; a
 * definition that only refers to others is inlined when short, so a shape written inline elsewhere in the schema
 * renders as the same text and can share one alias.
 */
export function inlineTinyRefs(schema: JsonSchema): JsonSchema {
	if (!isNode(schema) || !isNode(schema.$defs)) return schema;
	const defs = schema.$defs;
	const tiny = new Map<string, Node>();
	for (const [id, body] of Object.entries(defs)) {
		if (!isNode(body) || "properties" in body) continue;
		const text = JSON.stringify(body);
		if (text.length <= TINY_DEFINITION_CHARS && !text.includes(`"#/$defs/${id}"`)) tiny.set(id, body);
	}
	if (!tiny.size) return schema;
	const expand = (value: unknown, active: readonly string[]): unknown => {
		if (Array.isArray(value)) return value.map((item) => expand(item, active));
		if (!isNode(value)) return value;
		const id = typeof value.$ref === "string" ? DEFINITION.exec(value.$ref)?.[1] : undefined;
		const target = id === undefined ? undefined : tiny.get(id);
		if (id !== undefined && target && !active.includes(id)) {
			const { $ref: _ref, ...rest } = value;
			return expand({ ...target, ...rest }, [...active, id]);
		}
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, active)]));
	};
	const { $defs: _defs, ...rest } = schema;
	return { ...(expand(rest, []) as Node), $defs: defs };
}
