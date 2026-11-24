import { renderPrompt } from "../../core/prompt-template.ts";
import { UsagePersistenceError } from "../../core/usage-totals.ts";
import {
	type Api,
	type AssistantMessage,
	type Model,
	normalizeContext,
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
import { promptCacheKeyFor } from "../../core/cache-key-group.ts";
import { CONTEXT_SAFETY_TOKENS } from "@octocodeai/octocode-ai/api/simple-options";
import {
	rethrowSummaryRequestError,
	summaryProviderLimit,
	SummaryProviderLimitError,
} from "../../core/compaction/summary-failure.ts";
import { CHARS_PER_TOKEN, charsToTokens, estimateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { SUMMARY_CHECKPOINT_FORMAT, summarySizeTarget, TLDR_HEADING } from "../../core/compaction/summary-format.ts";
import { computeFileLists, formatFileOperations } from "../../core/compaction/utils.ts";
import { applyLedger, ledgerDetails, ledgerOf, ledgerPrompt } from "../../core/compaction/ledger.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
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
 * tool counts as a failure. An unusable reply allows a standalone summary. Provider limits and usage persistence failures end the compaction.
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
 * or is longer than the cap. `instructions` is the compaction's focus as the request states it, labelled by who wrote it
 * (`focusBlock`), or empty; the preservation rules are part of the request itself. `unusable` gets the reason
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
	ctx: Pick<FeatureContext, "cwd" | "modelRegistry" | "sessionManager">,
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
		const ceiling = summaryCapTokens(model, preparation.settings.reserveTokens);
		const target = summaryTargetTokens(ceiling);
		// The earlier checkpoint's standing constraints and decisions, which code writes back (`ledger.ts`).
		const ledger = ledgerOf(
			preparation.previousSummary === undefined ? undefined : splitSummary(preparation.previousSummary).body,
		);
		const prompt = [
			SHARED_SUMMARY_PROMPT,
			boundaryNote(projection.entries, preparation.firstKeptEntryId),
			// Every summary gets the size target: a first one without it ran past the cap on long sessions.
			`${preparation.previousSummary === undefined ? "" : PREVIOUS_SUMMARY_NOTE} ${summarySizeTarget(target)}`.trim(),
			archivedPreviousNote(projection.entries),
			ledgerPrompt(ledger),
			instructions,
		]
			.filter(Boolean)
			.join("\n\n");
		const transcript = convertToLlm(messages);
		// The plan can predate the current projection. Include the whole suffix, even an archived checkpoint or long focus.
		const input =
			Math.max(preparation.tokensBefore, estimateContextTokens(transcript, model).tokens) +
			charsToTokens(prompt.length, model);
		if (model.inputLimits?.maxInputTokens !== undefined && input > model.inputLimits.maxInputTokens)
			return fail(
				`the summary request needs about ${input} input tokens, over the ${model.inputLimits.maxInputTokens} input limit`,
			);
		const cap =
			model.contextWindow > 0 ? Math.min(ceiling, model.contextWindow - input - CONTEXT_SAFETY_TOKENS) : ceiling;
		if (cap < Math.max(1, target))
			return fail(`the window leaves ${Math.max(0, cap)} output tokens, under the ${target}-token checkpoint target`);
		const level = api.models.getThinkingLevel();
		const preferences = sessionCachePreferences(ctx, model, settings);
		// Only `long` instructions over shorter history can outlive the history entry; a rewritten prefix loses both.
		const instructionsLive =
			preferences.instructionCacheRetention === "long" &&
			preferences.cacheRetention !== "long" &&
			!rewritten &&
			!instructionsCold;
		const request = {
			messages: [
				...transcript,
				{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
			],
		};
		// The key the session's own requests carry (`create-session.ts`): its prefix group's on OpenAI, else the fork
		// chain's, so the summary reads the session's cache, and a fork's the parent's shard.
		const promptCacheKey = promptCacheKeyFor(ctx.sessionManager, ctx.cwd, model, normalizeContext(request).messages);
		const options: SimpleStreamOptions & { requestPriority: "compaction" } = {
			...preferences,
			requestPriority: "compaction",
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
			...(promptCacheKey ? { promptCacheKey } : {}),
			signal: event.signal,
			maxTokens: cap,
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
		const response = await retryAssistantCall(produce, policy?.retry, event.signal, policy?.callbacks).catch(
			rethrowSummaryRequestError,
		);
		const limited = response.stopReason === "error" && summaryProviderLimit(response.errorMessage);
		if (limited) throw limited;
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
		const carried = applyLedger(text, ledger);
		return {
			summary: `${carried.text}${formatFileOperations(lists.readFiles, lists.modifiedFiles)}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			usage: response.usage,
			details: { ...lists, ...ledgerDetails(carried.text, carried.lifted) },
		};
	} catch (error) {
		if (error instanceof UsagePersistenceError || error instanceof SummaryProviderLimitError) throw error;
		// An abort is the user's own cancel: the standalone request is cancelled too, so there is nothing to explain.
		if (!event.signal.aborted) unusable(errorMessage(error));
		return undefined;
	}
}
