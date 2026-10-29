import type { TSchema } from "typebox";

/** The declared parameters of a thin MCP tool with no readable top level: any object. */
const THIN_PARAMETERS = { type: "object", additionalProperties: true } as unknown as TSchema;

const JSON_TYPES = new Set(["array", "object", "string", "number", "integer", "boolean"]);

/** The JSON type a property schema declares, looking through one `$ref`-free union whose branches agree. */
function topType(schema: unknown): string | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	const node = schema as Record<string, unknown>;
	if (typeof node.type === "string" && JSON_TYPES.has(node.type)) return node.type;
	if (node.items !== undefined || node.prefixItems !== undefined) return "array";
	if (node.properties !== undefined) return "object";
	const branches = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
	if (!Array.isArray(branches)) return undefined;
	const types = new Set(branches.map(topType));
	return types.size === 1 ? [...types][0] : undefined;
}

/**
 * The declared parameters of a thin MCP tool: each top-level field with only its JSON type, open otherwise. Without
 * the top-level types, models send arrays and objects as JSON strings. The server's own schema still validates every
 * call (`validationParameters`) and the generated file carries the full shape.
 */
export function thinParameters(inputSchema: unknown): TSchema {
	if (!inputSchema || typeof inputSchema !== "object") return THIN_PARAMETERS;
	const root = inputSchema as Record<string, unknown>;
	const sources = [root, ...(((root.anyOf ?? root.oneOf) as unknown[] | undefined) ?? [])];
	const properties: Record<string, { type: string }> = {};
	for (const source of sources) {
		const props = (source as { properties?: Record<string, unknown> } | undefined)?.properties;
		if (!props || typeof props !== "object") continue;
		for (const [key, value] of Object.entries(props)) {
			const type = topType(value);
			if (type && !(key in properties)) properties[key] = { type };
		}
	}
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
