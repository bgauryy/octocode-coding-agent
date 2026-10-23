import type {
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Tool } from "../../types.ts";
import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "../constrained-sampling.ts";
import { toClaudeCodeName } from "./claude-code.ts";

/**
 * Stable deferred tool declared whenever native tool changes are in use. Anthropic adds
 * hidden prompt scaffolding for mid-conversation tool changes; declaring this placeholder
 * from the first request keeps that scaffolding in the cached prefix, so the first tool
 * change does not invalidate the cache (measured: full miss without it). It is never
 * activated and the model cannot see it.
 */
export const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
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
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
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

const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	return false;
};

export function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
	disablePreferredStrictTools = false,
): BetaTool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const config = tool.constrainedSampling;
		const strict =
			disablePreferredStrictTools && config && config.type === "json_schema" && config.strict === "prefer"
				? undefined
				: resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}
