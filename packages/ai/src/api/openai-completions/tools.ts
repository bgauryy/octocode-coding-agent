import type OpenAI from "openai";
import type { Tool } from "../../types.ts";
import {
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "../constrained-sampling.ts";
import type { ResolvedOpenAICompletionsCompat } from "./types.ts";

export function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// Only include strict if provider supports it. Some reject unknown fields.
				...(compat.supportsStrictMode && { strict: strict ?? false }),
			},
		};
	});
}
