import type { Tool as OpenAITool } from "openai/resources/responses/responses.js";
import type { Tool } from "../../types.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import type { TranscriptToolSupport } from "../../utils/transcript.ts";
import {
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "../constrained-sampling.ts";
import type { ConvertResponsesToolsOptions } from "./types.ts";

/**
 * How a Responses transport expresses tool changes.
 *
 * `additional_tools` items accumulate: a later item adds tools and replaces same-name
 * definitions from earlier items, but it cannot replace a top-level tool and cannot remove any
 * tool (verified with strict schemas on the OpenAI, Codex, and Copilot backends).
 * Every tool is therefore declared in `additional_tools` items, starting with one
 * at the head of the input, and removals are announced as text. Synthetic tool search can
 * only add tools. Without mid-conversation system messages there is nothing to anchor.
 */
export function getResponsesToolSupport(options: {
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
}): TranscriptToolSupport {
	return resolveToolLoadingMode("openai-responses", options);
}

/**
 * Precedes every additional_tools item after the first. Without it, models read the latest item as
 * the complete tool set once a removal was announced; Codex precedes its incremental tool batches
 * with the same guidance. Restating the tools that are still unavailable keeps smaller models
 * (gpt-5.6-luna, gpt-6-luna) from calling them again after later loads (verified October 2026).
 */
export function renderIncrementalToolsNotice(unavailable: ReadonlySet<string>): string {
	const notice =
		"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";
	return unavailable.size > 0 ? `${notice}\nStill unavailable: ${[...unavailable].join(", ")}.` : notice;
}

export function renderToolRemovalNotice(names: readonly string[]): string {
	return `The following tools are no longer available. Do not call them:\n${names.map((name) => `- ${name}`).join("\n")}`;
}

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
		}
		return functionTool as OpenAITool;
	});
}
