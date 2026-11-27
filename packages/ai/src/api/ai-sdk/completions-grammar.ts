import type { Model } from "../../types.ts";
import { getDeclaredTools, type TranscriptContext } from "../../utils/transcript.ts";
import { getGrammarToolInput, resolveGrammarConstrainedSampling } from "../constrained-sampling.ts";
import { getCompat } from "../openai-completions/compat.ts";
import { convertTools } from "../openai-completions/tools.ts";

interface WireTool {
	type?: string;
	function?: { name: string; arguments: string };
}

export function augmentGrammarTools(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	body: Record<string, unknown>,
): void {
	const compat = getCompat(model);
	const definitions = getDeclaredTools(context.messages);
	const grammar = new Map(
		definitions.flatMap((definition) => {
			const sampling = resolveGrammarConstrainedSampling(definition, compat.supportsOpenAIGrammarTools);
			return sampling ? [[definition.name, { definition, sampling }] as const] : [];
		}),
	);
	if (!grammar.size) return;
	if (Array.isArray(body.tools))
		body.tools = (body.tools as WireTool[]).map((tool) => {
			const entry = tool.function && grammar.get(tool.function.name);
			return entry ? convertTools([entry.definition], compat)[0] : tool;
		});
	if (Array.isArray(body.messages))
		for (const message of body.messages as { tool_calls?: WireTool[] }[]) {
			if (!message.tool_calls) continue;
			message.tool_calls = message.tool_calls.map((call) => {
				const entry = call.function && grammar.get(call.function.name);
				if (!entry || !call.function) return call;
				const { function: fn, ...rest } = call;
				return {
					...rest,
					type: "custom",
					custom: {
						name: fn.name,
						input: getGrammarToolInput(fn.name, JSON.parse(fn.arguments), entry.sampling.inputProperty),
					},
				};
			});
		}
}
