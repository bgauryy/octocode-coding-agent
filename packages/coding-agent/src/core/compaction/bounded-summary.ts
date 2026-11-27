/**
 * One-shot summary requests (a split turn's prefix) that shrink and retry like a history summary.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy } from "@octocodeai/octocode-ai";
import type { Model, Usage } from "@octocodeai/octocode-ai/compat";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { renderPrompt } from "../prompt-template.ts";
import { completeBounded, createSummarizationOptions } from "./summarization.ts";
import { summaryFailure } from "./summary-failure.ts";
import { focusBlock, type SummaryFocus } from "./summary-focus.ts";
import { serializeMessages } from "./utils.ts";

const TURN_PREFIX_SUMMARIZATION_PROMPT = renderPrompt("workflows/compaction/turn-prefix.md");

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
export async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	customInstructions?: string | SummaryFocus,
	cache?: CachePreferences,
): Promise<{ text: string; usage: Usage }> {
	const response = await completeBounded(
		messages,
		(remaining) => {
			const focus = focusBlock(customInstructions);
			return `# Conversation\n${serializeMessages(remaining)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}${focus ? `\n\n${focus}` : ""}`;
		},
		model,
		createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId, cache),
		streamFn,
		retry,
		callbacks,
	);

	const failure = summaryFailure(response, "Turn prefix summarization", model);
	if (failure) {
		throw failure;
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		text: contentText(response.content),
		usage: response.usage,
	};
}
