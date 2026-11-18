/** Schema keywords whose values map names to subschemas, so their keys are not schema keywords. */
const JSON_SCHEMA_NAME_MAPS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);

/** Keywords holding a subschema or an array of subschemas, not literal data. */
const JSON_SCHEMA_SUBSCHEMAS = new Set([
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
]);

/**
 * A tool schema for Gemini's `parametersJsonSchema`, with string and number `const` values sent as single-value `enum`s:
 * Gemini ignores `const` there but honors `enum`. Only schemas are rewritten, never literal data (`default`,
 * `examples`, `enum` values, unknown keywords), and names such as `__proto__` stay own properties. The input is not
 * changed.
 */
export function geminiToolSchema(schema: unknown, isNameMap = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => geminiToolSchema(item));
	if (typeof schema !== "object" || schema === null) return schema;
	// fromEntries keeps names such as __proto__ as own properties.
	const result: Record<string, unknown> = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => {
			if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key)) return [key, geminiToolSchema(value)];
			if (JSON_SCHEMA_NAME_MAPS.has(key)) return [key, geminiToolSchema(value, true)];
			return [key, value];
		}),
	);
	if (!isNameMap && "const" in result && result.enum === undefined) {
		const value = result.const;
		if (typeof value === "string" || typeof value === "number") {
			delete result.const;
			result.enum = [value];
		}
	}
	return result;
}
