/**
 * LLM summarization calls shared by compaction and branch summaries.
 */

import { renderPrompt } from "../prompt-template.ts";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
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
import { combineUsage } from "../usage-totals.ts";
import { estimateTokens } from "./tokens.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, serializeMessages } from "./utils.ts";
import { inlineSummaryTokens, summaryTargetTokens } from "./checkpoint.ts";
import {
	STOPPED_HEADING,
	SUMMARY_CHECKPOINT_FORMAT,
	summarySection,
	summarySizeTarget,
	TLDR_HEADING,
} from "./summary-format.ts";
import { summaryMaxTokens, summaryThinkingLevel } from "./settings.ts";

const SUMMARIZATION_PROMPT = renderPrompt("workflows/compaction/summarize.md", {
	format: SUMMARY_CHECKPOINT_FORMAT,
});

const UPDATE_SUMMARIZATION_PROMPT = renderPrompt("workflows/compaction/summarize-update.md", {
	format: SUMMARY_CHECKPOINT_FORMAT,
	tldrHeading: TLDR_HEADING,
});

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop or a cancel (providers return `aborted` rather than throwing) leaves partial text, which must not
 * become a session checkpoint.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "aborted") {
		return `${label} was cancelled`;
	}
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete (output ${response.usage.output} tokens)`;
	}
	if (!response.content.some((block) => block.type === "toolCall") && !contentText(response.content).trim()) {
		return `${label} failed: the summary was empty`;
	}
	return undefined;
}

export function createSummarizationOptions(
	model: Model<any>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
	cache: CachePreferences | undefined,
): SimpleStreamOptions {
	// Sized for a summary, not for the model's longest reply: without a cap one request ran on for more than ten minutes.
	const options: SimpleStreamOptions = {
		signal,
		apiKey,
		headers,
		env,
		sessionId,
		...cache,
		maxTokens: summaryMaxTokens(model),
	};
	const level = summaryThinkingLevel(thinkingLevel);
	if (model.reasoning && level && level !== "off") {
		options.reasoning = level;
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
	// A caller that passes the session's routing id and cache preferences (a compaction summary) is routed and cached as
	// the session is. A one-off summary without them (a branch summary, a bug report) writes nothing to the cache,
	// since nothing reads it back, and gets a fresh routing id.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: options.cacheRetention ?? "none",
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

/** Whether the provider refused a summary request as too large for its window, and nobody cancelled it meanwhile. */
const overflowed = (response: AssistantMessage, signal: AbortSignal | undefined): boolean =>
	response.stopReason === "error" && isContextOverflow(response) && !signal?.aborted;

/**
 * Where to split `messages` so the older part can be summarized on its own: about half their estimated tokens, with
 * at least one message on each side and no tool result parted from its call. Undefined when no such point exists.
 */
function olderPartEnd(messages: AgentMessage[]): number | undefined {
	if (messages.length < 2) return undefined;
	const sizes = messages.map(estimateTokens);
	const half = sizes.reduce((sum, size) => sum + size, 0) / 2;
	let cut = 1;
	for (let seen = sizes[0]; cut < messages.length - 1 && seen < half; cut++) seen += sizes[cut];
	const fits = (at: number) => messages[at].role !== "toolResult";
	for (let at = cut; at < messages.length; at++) if (fits(at)) return at;
	for (let at = cut - 1; at > 0; at--) if (fits(at)) return at;
	return undefined;
}

/**
 * Run a summary request over `messages`. When the provider rejects it as a context overflow, drop the oldest
 * messages and retry, up to {@link OVERFLOW_TRIM_SHARES} times; then return the failed
 * response for the caller to report. `buildPrompt` receives the messages that remain. `first`: the response the
 * whole request already got (an overflow), so it is not sent again.
 */
async function completeWithOverflowTrim(
	messages: AgentMessage[],
	buildPrompt: (messages: AgentMessage[]) => string,
	model: Model<any>,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	first?: AssistantMessage,
): Promise<AssistantMessage> {
	let remaining = messages;
	let pending = first;
	for (let trims = 0; ; trims++) {
		const dropped = messages.length - remaining.length;
		// The summary must not claim to cover what it never saw.
		const note = dropped > 0 ? `\n\n${renderPrompt("workflows/compaction/dropped-messages.md", { dropped })}` : "";
		const response =
			pending ??
			(await completeSummarization(
				model,
				buildSummarizationContext(`${buildPrompt(remaining)}${note}`),
				options,
				streamFn,
				retry,
				callbacks,
			));
		pending = undefined;
		if (!overflowed(response, options.signal)) return response;
		const share = OVERFLOW_TRIM_SHARES[trims];
		const trimmed = share === undefined ? undefined : dropOldestMessages(remaining, share);
		if (!trimmed) return response;
		remaining = trimmed;
	}
}

const CUT_OFF_NOTE = renderPrompt("workflows/compaction/cut-off-note.md");

/**
 * The text of a history summary after every shrinking retry: one still cut off at the cap is kept, marked as cut, when it
 * already says where the work stopped (the sections after it only condense); otherwise it throws like `summaryText`.
 */
function keptSummaryText(response: AssistantMessage): string {
	if (response.stopReason === "length" && !response.content.some((block) => block.type === "toolCall")) {
		const text = contentText(response.content).trim();
		if (summarySection(text, STOPPED_HEADING).length > 0) return `${text}\n\n${CUT_OFF_NOTE.trim()}`;
	}
	return summaryText(response);
}

/** The text of a finished summary response; throws when it failed, was cut off or asked for a tool. */
function summaryText(response: AssistantMessage): string {
	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}
	return contentText(response.content);
}

/** Retries of a summary cut off at the output cap, each asking for half the size. */
const MAX_SHRINKS = 3;
/** The smallest output cap a retry lowers to. */
const MIN_SUMMARY_CAP = 1024;

/** `prompt` asking for a summary of at most the share of `room` tokens that remains after `shrink` halvings. */
function sizedPrompt(prompt: string, room: number, shrink: number): string {
	const target = summarySizeTarget(Math.floor(summaryTargetTokens(room) / shrink));
	return target ? `${prompt}\n\n${target}` : prompt;
}

/**
 * A summary request over `messages` that shrinks and retries: an overflow drops the oldest messages and a reply cut off
 * at the output cap is asked again, up to {@link MAX_SHRINKS} times, without reasoning and for half the size each
 * time (from the second retry the output cap halves too). The usage reported is the sum over every request.
 * `sizing.room`: the tokens the summary is sized against, applied from the first request; without it only retries
 * carry a size target (against the model's output cap). `sizing.first`: a response the whole request already got.
 */
export async function completeBounded(
	messages: AgentMessage[],
	buildPrompt: (messages: AgentMessage[]) => string,
	model: Model<any>,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sizing?: { room?: number; first?: AssistantMessage },
): Promise<AssistantMessage> {
	const room = sizing?.room;
	const firstPrompt =
		room === undefined ? buildPrompt : (remaining: AgentMessage[]) => sizedPrompt(buildPrompt(remaining), room, 1);
	let response = await completeWithOverflowTrim(
		messages,
		firstPrompt,
		model,
		options,
		streamFn,
		retry,
		callbacks,
		sizing?.first,
	);
	// Every retry is billed: the usage reported is the sum over the requests, not the last one's.
	let usage = response.usage;
	let shrink = 1;
	let current = options;
	for (let tries = 0; response.stopReason === "length" && !options.signal?.aborted && tries < MAX_SHRINKS; tries++) {
		const { reasoning: _dropped, ...plain } = current;
		current = plain;
		if (tries > 0) {
			const cap = current.maxTokens ?? summaryMaxTokens(model);
			current = { ...current, maxTokens: Math.max(MIN_SUMMARY_CAP, Math.floor(cap / 2)) };
		}
		shrink *= 2;
		const sized = (remaining: AgentMessage[]) =>
			sizedPrompt(buildPrompt(remaining), room ?? summaryMaxTokens(model), shrink);
		response = await completeWithOverflowTrim(messages, sized, model, current, streamFn, retry, callbacks);
		usage = combineUsage(usage, response.usage);
	}
	return response.usage === usage ? response : { ...response, usage };
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Sets only the size an update is asked to stay under; the output cap is `summaryMaxTokens`.
	reserveTokens: number | undefined,
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
	cache?: CachePreferences,
): Promise<{ text: string; usage: Usage }> {
	// Every summary is asked for a size (a first one without it ran past the cap); `completeBounded` halves it per retry.
	const room = reserveTokens ? inlineSummaryTokens(reserveTokens) : summaryMaxTokens(model);
	const buildPrompt =
		(previous: string | undefined) =>
		(messages: AgentMessage[]): string => {
			// Serialize conversation to text so model doesn't try to continue it; custom messages keep their type as the label.
			const conversationText = serializeMessages(messages);
			let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
			if (previous) {
				promptText += `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
			}
			// Use the update prompt if we have a previous summary, the initial prompt otherwise.
			promptText += previous ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
			return customInstructions ? `${promptText}\n\nAdditional focus: ${customInstructions}` : promptText;
		};

	const options = createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId, cache);
	const complete = (messages: AgentMessage[], previous: string | undefined, first?: AssistantMessage) =>
		completeBounded(messages, buildPrompt(previous), model, options, streamFn, retry, callbacks, { room, first });

	const whole = await completeSummarization(
		model,
		buildSummarizationContext(sizedPrompt(buildPrompt(previousSummary)(currentMessages), room, 1)),
		options,
		streamFn,
		retry,
		callbacks,
	);
	const split = overflowed(whole, signal) ? olderPartEnd(currentMessages) : undefined;
	// Nothing to split (it fits, it failed otherwise, or it is one message): the whole request's answer stands, and an
	// overflow goes on by dropping the oldest messages.
	if (split === undefined) {
		const response = await complete(currentMessages, previousSummary, whole);
		return { text: keptSummaryText(response), usage: response.usage };
	}
	// Too large for one request: the older part is summarized on its own, and that summary is the previous summary of
	// the newer part, so the oldest history is condensed twice instead of left out. A part that still does not fit
	// drops its own oldest messages and says so.
	const older = await complete(currentMessages.slice(0, split), previousSummary);
	const olderSummary = keptSummaryText(older);
	const newer = await complete(currentMessages.slice(split), olderSummary);
	return { text: keptSummaryText(newer), usage: combineUsage(older.usage, newer.usage) };
}
