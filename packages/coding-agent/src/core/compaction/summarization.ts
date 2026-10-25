/**
 * LLM summarization calls shared by compaction and branch summaries.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import {
	contentText,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@octocodeai/octocode-ai";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@octocodeai/octocode-ai/compat";
import { completeSimple, isContextOverflow } from "@octocodeai/octocode-ai/compat";
import { convertToLlm } from "../messages.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, serializeConversation } from "./utils.ts";
import { SUMMARY_CHECKPOINT_FORMAT } from "./summary-format.ts";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

${SUMMARY_CHECKPOINT_FORMAT}`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

function createSummarizationOptions(
	model: Model<any>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { signal, apiKey, headers, env, sessionId };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
	// callers without a session ID, including branch summaries, receive a fresh routing ID.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
	const produce = async (): Promise<AssistantMessage> =>
		streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions);
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(...args: Parameters<typeof generateSummaryWithUsage>): Promise<string> {
	return (await generateSummaryWithUsage(...args)).text;
}

/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

/** Share of the remaining messages each overflow retry drops from the oldest end; its length bounds the retries. */
const OVERFLOW_TRIM_SHARES = [0.25, 0.4, 0.6];

/**
 * Drop the oldest `share` of `messages`, at least one, and never the last. A tool result whose call was dropped goes
 * too, so no result is left without its call. Returns undefined when nothing can be dropped.
 */
function dropOldestMessages(messages: AgentMessage[], share: number): AgentMessage[] | undefined {
	if (messages.length <= 1) return undefined;
	let cut = Math.min(messages.length - 1, Math.max(1, Math.ceil(messages.length * share)));
	while (cut < messages.length - 1 && messages[cut].role === "toolResult") cut++;
	return messages.slice(cut);
}

/**
 * Run a summary request over `messages`. When the provider rejects it as a context overflow, drop the oldest
 * messages and retry, up to {@link OVERFLOW_TRIM_SHARES} times (Codex compacts the same way); then return the failed
 * response for the caller to report. `buildPrompt` receives the messages that remain.
 */
async function completeWithOverflowTrim(
	messages: AgentMessage[],
	buildPrompt: (messages: AgentMessage[]) => string,
	model: Model<any>,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	let remaining = messages;
	for (let trims = 0; ; trims++) {
		const response = await completeSummarization(
			model,
			buildSummarizationContext(buildPrompt(remaining)),
			options,
			streamFn,
			retry,
			callbacks,
		);
		if (response.stopReason !== "error" || !isContextOverflow(response) || options.signal?.aborted) return response;
		const share = OVERFLOW_TRIM_SHARES[trims];
		const trimmed = share === undefined ? undefined : dropOldestMessages(remaining, share);
		if (!trimmed) return response;
		remaining = trimmed;
	}
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Unused. Kept for existing callers; summaries use the model's output limit (#9512).
	_reserveTokens: number | undefined,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const buildPrompt = (messages: AgentMessage[]): string => {
		// Serialize conversation to text so model doesn't try to continue it.
		// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
		const conversationText = serializeConversation(convertToLlm(messages));
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		return promptText + basePrompt;
	};

	const response = await completeWithOverflowTrim(
		currentMessages,
		buildPrompt,
		model,
		createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	const textContent = contentText(response.content);

	return { text: textContent, usage: response.usage };
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

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
	customInstructions?: string,
): Promise<{ text: string; usage: Usage }> {
	const response = await completeWithOverflowTrim(
		messages,
		(remaining) =>
			`# Conversation\n${serializeConversation(convertToLlm(remaining))}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}${customInstructions ? `\n\nAdditional summary focus:\n${customInstructions}` : ""}`,
		model,
		createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		text: contentText(response.content),
		usage: response.usage,
	};
}
