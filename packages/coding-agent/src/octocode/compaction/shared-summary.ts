import { renderPrompt } from "../../core/prompt-template.ts";
import { UsagePersistenceError } from "../../core/usage-totals.ts";
import {
	type Api,
	type AssistantMessage,
	type Model,
	retryAssistantCall,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { archivedSummary, inlineSummaryTokens, summaryTargetTokens } from "../../core/compaction/checkpoint.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { FeatureSetup, SetupPick, FeatureContext, SessionBeforeCompactEvent } from "../../core/features/index.ts";
import { withoutHiddenDeclarations } from "../../core/hidden-declarations.ts";
import { convertToLlm } from "../../core/messages.ts";
import { projectForcedSystemPrompt } from "../../core/forced-system-prompt.ts";
import { forkPromptCacheKey } from "../../core/session-manager/cache-key.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { SUMMARY_CHECKPOINT_FORMAT, summarySizeTarget, TLDR_HEADING } from "../../core/compaction/summary-format.ts";
import { computeFileLists, formatFileOperations } from "../../core/compaction/utils.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { clipText, contentText } from "../shared/util.ts";
import { latestReminderOnly } from "../shared/reminder-view.ts";
import { prefixRewritten } from "./clearing.ts";
import { requestView } from "./request-view.ts";
import { historyPrefixRewritten } from "./history-cache.ts";

/**
 * The summary request that reads the conversation from the prompt cache. Octocode's `compact()` serializes the conversation
 * into a new prompt under its own system prompt, so the provider sees a prefix it never cached and bills the whole
 * context as fresh input. Here the request is the session's own (the same system and tool declarations, messages, model,
 * thinking level and routing id) with one user message added at the end. The provider can reuse the cached prefix;
 * uncached suffixes, output and any cache writes remain billable. Tools stay declared and the thinking settings stay as they are,
 * because changing either invalidates the cached messages; the reply is told to be text only, and a reply that calls a
 * tool counts as a failure. Any failure returns nothing and the caller writes the summary the standalone way.
 */

/** What writing a summary needs of the feature API, whichever request ends up writing it. */
export type SummaryApi = Pick<FeatureSetup, "models" | "tools" | "settings" | "session" | "usage">;

/** The checkpoint request appended to the cached conversation. */
export const SHARED_SUMMARY_PROMPT = renderPrompt("workflows/compaction/shared-request.md", {
	format: SUMMARY_CHECKPOINT_FORMAT,
});

/** Said when the conversation starts with an earlier summary, which this one replaces. */
const PREVIOUS_SUMMARY_NOTE = renderPrompt("workflows/compaction/shared-previous-summary.md", {
	tldrHeading: TLDR_HEADING,
});

/**
 * The complete text of the earlier checkpoint when it was too long to stay inline and the conversation shows only a
 * reference to its saved file. It goes into the final message rather than replacing the reference, so the cached
 * messages stay the same.
 */
function archivedPreviousNote(entries: ReadonlyArray<{ sourceEntry: unknown; messages: unknown[] }>): string {
	const previous = entries.find(
		(entry) => isRecord(entry.sourceEntry) && entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	const text = isRecord(previous?.sourceEntry) ? archivedSummary(previous.sourceEntry.details) : undefined;
	return text === undefined ? "" : renderPrompt("workflows/compaction/shared-archived-summary.md", { text });
}

/** The longest a quoted start of a message gets. */
const QUOTE_CHARS = 120;

const quote = (text: string): string => clipText(text.replace(/\s+/g, " ").trim(), QUOTE_CHARS);

/** How the message is told apart in words, or undefined when it has nothing to quote. */
function describeMessage(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const content = message.content;
	const text = contentText(content);
	if (message.role === "toolResult") return `result of the ${String(message.toolName)} tool call`;
	const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
	if (!role) return undefined;
	if (quote(text)) return `${role} message beginning "${quote(text)}"`;
	const toolCall = Array.isArray(content)
		? content.find((part) => isRecord(part) && part.type === "toolCall")
		: undefined;
	return isRecord(toolCall)
		? `${role} message that calls the ${String(toolCall.name)} tool with ${quote(JSON.stringify(toolCall.arguments))}`
		: undefined;
}

/**
 * Where the kept messages begin, as the model can recognise it. The model sees the whole conversation, but the messages
 * from `firstKeptEntryId` on stay in context after the summary, so it summarizes what comes before them.
 */
function boundaryNote(
	entries: ReadonlyArray<{ sourceEntry: { id: string }; messages: unknown[] }>,
	firstKeptEntryId: string,
): string {
	const kept = entries.find((entry) => entry.sourceEntry.id === firstKeptEntryId);
	const first = kept?.messages.map(describeMessage).find((description) => description !== undefined);
	return first === undefined ? "" : renderPrompt("workflows/compaction/shared-boundary.md", { first });
}

/** What the provider keeps free of a request's context window (`clampMaxTokensToContext`). */
const CONTEXT_MARGIN_TOKENS = 4096;

/** Octocode's cap on a summary: what fits inline (`inlineSummaryTokens`), and never beyond what the model can write. */
function summaryCapTokens(model: Pick<Model<Api>, "maxTokens">, reserveTokens: number): number {
	return Math.min(inlineSummaryTokens(reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
}

/** The session's own cache preferences for `model`, as its requests resolve them (settings over the registry's layers). */
export function sessionCachePreferences(
	ctx: Pick<FeatureContext, "modelRegistry">,
	model: Model<Api>,
	settings: ReturnType<FeatureSetup["settings"]["get"]>,
): CachePreferences {
	return ctx.modelRegistry.getCachePolicy(model, [{ source: "session settings", values: settings }]).options;
}

/**
 * Whether the reply is longer than the cap: by the provider's output count when it reports one, else by the character
 * estimate. The count is what `maxTokens` bounded, so a reply within it is never refused for having short tokens.
 */
function overCap(response: AssistantMessage, text: string, cap: number): boolean {
	const output = response.usage?.output;
	const estimate = text.length / CHARS_PER_TOKEN;
	// The output count includes thinking: only text that is itself past the cap is too long.
	return (output ? output : estimate) > cap && estimate > cap;
}

/**
 * Octocode's compaction result from the cache-sharing request, or undefined when it cannot be used: images are blocked
 * (the request would carry them), the call or the projection failed, or the reply stopped early, is empty, calls a tool
 * or is longer than the cap. `instructions` are Octocode's built-in summary focus. `unusable` gets the reason
 * for every failure, so the caller can say why it falls back to a request that bills the whole input; `userChoice` marks
 * blocked images, the user's own setting, which needs no warning. A cancel (abort) reports nothing. `cacheCold`: the
 * history's cache entry has expired, so this request has nothing to read there, and what it would write is never read,
 * because the summary replaces those messages in the next request. `instructionsCold` (default: `cacheCold`): the
 * instruction entry (system prompt and tools) has expired too. Instructions outlive history when their retention is
 * `long` over shorter history; then a cold request still marks them, reading the live entry and keeping it for the
 * next request, and only history goes unmarked. A request that rewrites the prefix anyway
 * (`prefixRewritten`: a switch of a physical session model since the last reply, or a trailing update the transcript folds into the leading
 * prompt) is cold the same way.
 */
export async function sharedSummary(
	api: SetupPick<"models", "getThinkingLevel"> &
		SetupPick<"settings", "get"> &
		SetupPick<"tools", "getHiddenDeclarations">,
	event: Pick<SessionBeforeCompactEvent, "preparation" | "signal" | "summaryRequest">,
	ctx: Pick<FeatureContext, "modelRegistry" | "sessionManager">,
	model: Model<Api>,
	instructions: string,
	unusable: (reason: string, userChoice?: boolean) => void = () => undefined,
	recordUsage?: (message: AssistantMessage) => void,
	cacheCold = false,
	instructionsCold = cacheCold,
	requireWarmPrefix = false,
): Promise<CompactionResult | undefined> {
	const fail = (reason: string, userChoice?: boolean): undefined => {
		unusable(reason, userChoice);
		return undefined;
	};
	try {
		const settings = api.settings.get();
		// Octocode replaces images with a note in a session's requests; this request cannot show them, so it is not made.
		if (settings.images?.blockImages) return fail("images are blocked in settings", true);
		const { preparation } = event;
		const projection = ctx.sessionManager.buildSessionProjection();
		// The projection as every live request sends it: Octocode's own `context` transform (`requestView`) and, in a
		// child, only the latest identity reminder, so the cached prefix is the same.
		const projected = requestView(
			latestReminderOnly(withoutHiddenDeclarations(projection.messages, new Set(api.tools.getHiddenDeclarations()))),
			ctx.sessionManager,
			model,
		);
		const messages = projectForcedSystemPrompt(projected, event.summaryRequest?.forceSystemPrompt);
		const rewritten = prefixRewritten(messages, model);
		const cold = cacheCold || rewritten || historyPrefixRewritten(ctx.sessionManager);
		if (requireWarmPrefix && cold) return fail("the request prefix is cold");
		const cap = summaryCapTokens(model, preparation.settings.reserveTokens);
		// A near-full window leaves less output than the cap (the provider clamps to it): the reply would only be cut off.
		const room = model.contextWindow - preparation.tokensBefore - CONTEXT_MARGIN_TOKENS;
		if (model.contextWindow > 0 && room < cap)
			return fail(`the window leaves ${Math.max(0, room)} output tokens, under the ${cap} cap`);
		const prompt = [
			SHARED_SUMMARY_PROMPT,
			boundaryNote(projection.entries, preparation.firstKeptEntryId),
			// Every summary gets the size target: a first one without it ran past the cap on long sessions.
			`${preparation.previousSummary === undefined ? "" : PREVIOUS_SUMMARY_NOTE} ${summarySizeTarget(summaryTargetTokens(cap))}`.trim(),
			archivedPreviousNote(projection.entries),
			`Additional focus:\n${instructions}`,
		]
			.filter(Boolean)
			.join("\n\n");
		const level = api.models.getThinkingLevel();
		const preferences = sessionCachePreferences(ctx, model, settings);
		// Only `long` instructions over shorter history can outlive the history entry; a rewritten prefix loses both.
		const instructionsLive =
			preferences.instructionCacheRetention === "long" &&
			preferences.cacheRetention !== "long" &&
			!rewritten &&
			!instructionsCold;
		const promptCacheKey = forkPromptCacheKey(ctx.sessionManager.getHeader());
		const options: SimpleStreamOptions = {
			...preferences,
			// A cold history is not marked (nothing reads what it writes). History `none` makes octocode-ai send no markers
			// and drop the cache routing id (OpenCode keeps its required `x-opencode-session` header), unless
			// `keepInstructionCache` keeps the instruction markers: that entry is live, this request reads it and the next
			// request reads what it keeps. Both cold: no markers at all.
			...(cold ? { cacheRetention: "none" as const, ...(instructionsLive ? { keepInstructionCache: true } : {}) } : {}),
			// The session's own thinking level, budgets, transport and routing id: each one changes what the provider caches.
			...(level === "off" ? {} : { reasoning: level }),
			...(settings.thinkingBudgets ? { thinkingBudgets: settings.thinkingBudgets } : {}),
			...(settings.transport ? { transport: settings.transport } : {}),
			sessionId: ctx.sessionManager.getSessionId(),
			// The key the session's own requests carry (`create-session.ts`), so a fork's summary reads the parent's shard.
			...(promptCacheKey ? { promptCacheKey } : {}),
			signal: event.signal,
			maxTokens: cap,
		};
		const request = {
			messages: [
				...convertToLlm(messages),
				{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
			],
		};
		// Watched and retried as the session's summary requests are: a retry reads the same cached prefix.
		const policy = event.summaryRequest;
		const send = policy?.watch(ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry));
		const produce = async () => {
			const stream = await (send?.(model, request, options) ?? ctx.modelRegistry.streamSimple(model, request, options));
			const attempt = await stream.result();
			recordUsage?.(attempt);
			return attempt;
		};
		const response = await retryAssistantCall(produce, policy?.retry, event.signal, policy?.callbacks);
		if (response.stopReason !== "stop")
			return fail(
				response.stopReason === "length"
					? `the reply stopped with length (output ${response.usage?.output ?? "?"} tokens, cap ${cap})`
					: `the reply stopped with ${response.stopReason}`,
			);
		if (response.content.some((block) => block.type === "toolCall")) return fail("the reply called a tool");
		const text = contentText(response.content).trim();
		if (text === "") return fail("the reply was empty");
		if (overCap(response, text, cap)) return fail("the reply was longer than the cap");
		const lists = computeFileLists(preparation.fileOps);
		return {
			summary: `${text}${formatFileOperations(lists.readFiles, lists.modifiedFiles)}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			usage: response.usage,
			details: lists,
		};
	} catch (error) {
		if (error instanceof UsagePersistenceError) throw error;
		// An abort is the user's own cancel: the standalone request is cancelled too, so there is nothing to explain.
		if (!event.signal.aborted) unusable(errorMessage(error));
		return undefined;
	}
}
