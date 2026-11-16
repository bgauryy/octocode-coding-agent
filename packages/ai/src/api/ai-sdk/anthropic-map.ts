import { jsonSchema, tool, type ToolSet } from "ai";
import type { Tool } from "../../types.ts";
import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "../constrained-sampling.ts";
import { liftRootComposition } from "../../utils/json-schema-shape.ts";

const UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
const unsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !STRING_FORMATS.has(value);
	return false;
};

export function anthropicToolSchema(declared: Tool, supportsStrictTools: boolean, disablePreferredStrictTools = false) {
	const definition = { ...declared, parameters: liftRootComposition(declared.parameters) };
	const config = definition.constrainedSampling;
	const strict =
		disablePreferredStrictTools && config && config.type === "json_schema" && config.strict === "prefer"
			? undefined
			: resolveJsonSchemaStrictSampling(definition, supportsStrictTools, unsupportedKeyword);
	const parameters = getJsonSchemaToolParameters(definition, strict) as Record<string, unknown> & {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	const schema = {
		...(strict === true ? parameters : {}),
		type: "object" as const,
		properties: parameters.properties ?? {},
		required: parameters.required ?? [],
		...(parameters.additionalProperties === undefined ? {} : { additionalProperties: parameters.additionalProperties }),
		...(parameters.$defs === undefined ? {} : { $defs: parameters.$defs }),
		...(parameters.definitions === undefined ? {} : { definitions: parameters.definitions }),
	};
	return { schema, strict };
}

export function anthropicSdkTools(
	definitions: Tool[],
	supportsStrictTools: boolean,
	disablePreferredStrictTools = false,
): ToolSet {
	return Object.fromEntries(
		definitions.map((definition) => {
			if (definition.constrainedSampling && definition.constrainedSampling.type === "grammar") {
				throw new Error(
					`Tool "${definition.name}" cannot use grammar constrained sampling: Anthropic grammar tools are unsupported.`,
				);
			}
			const { schema, strict } = anthropicToolSchema(definition, supportsStrictTools, disablePreferredStrictTools);
			return [
				definition.name,
				tool({
					description: definition.description,
					inputSchema: jsonSchema(schema),
					...(strict === true ? { strict: true } : {}),
				}),
			];
		}),
	);
}
