import { FunctionCallingConfigMode } from "@google/genai";
import type { Tool } from "../../types.ts";
import { liftRootComposition } from "../../utils/json-schema-shape.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "../constrained-sampling.ts";
import { getGeminiMajorVersion } from "./messages.ts";

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/** Keywords whose value maps names (property names or patterns) to schemas; the names are data. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);

/** Keywords whose value is one schema or a list of schemas. */
const SCHEMA_KEYWORDS = new Set([
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"items",
	"prefixItems",
	"additionalItems",
	"contains",
	"additionalProperties",
	"propertyNames",
	"unevaluatedProperties",
	"unevaluatedItems",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Strip meta-declarations from a schema node and the schemas nested in it. A name map keeps every name, also `$id` or
 * `__proto__`; literal data (`const`, `enum`, `default`, `examples`) and other annotations are copied untouched.
 * `Object.fromEntries` defines own properties, so no name sets a prototype.
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (!isPlainObject(schema)) return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key]) => !JSON_SCHEMA_META_DECLARATIONS.has(key))
			.map(([key, value]) => [key, sanitizeKeyword(key, value)]),
	);
}

function sanitizeKeyword(key: string, value: unknown): unknown {
	if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, sanitizeForOpenApi(entry)]));
	}
	if (!SCHEMA_KEYWORDS.has(key)) return value;
	return Array.isArray(value) ? value.map(sanitizeForOpenApi) : sanitizeForOpenApi(value);
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				const parameters = getJsonSchemaToolParameters(tool, strict);
				return {
					name: tool.name,
					description: tool.description,
					// Legacy `parameters` becomes Anthropic's input_schema on Cloud Code Assist, which rejects root composition.
					...(useParameters
						? { parameters: sanitizeForOpenApi(liftRootComposition(parameters)) }
						: { parametersJsonSchema: parameters }),
				};
			}),
		},
	];
}

/** Gemini 3+ enforces required function parameters in validated tool-calling modes. */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

/** Map tool choice string to Gemini FunctionCallingConfigMode. */
function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}
