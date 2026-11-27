/** Keywords TypeScript cannot express; they move to the property's JSDoc. */
export const NOTE_KEYS = [
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"default",
	"deprecated",
] as const;

/** Keywords that give a node a shape. A node without any is a placeholder (`{}`) or constraints only. */
export const SHAPE_KEYS = [
	"type",
	"properties",
	"items",
	"prefixItems",
	"anyOf",
	"oneOf",
	"allOf",
	"enum",
	"const",
	"$ref",
	"additionalProperties",
];

export const UNSUPPORTED_SHAPE = "unknown /* unsupported schema shape */";
