import type { NativeCompactionResult } from "../../core/compaction/native-result.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	inlineSummaryTokens,
	persistCheckpointText,
	spillFileLists,
} from "../../core/compaction/index.ts";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { clearedResults } from "../files/reads.ts";
import { nextSegment } from "../history/archive.ts";
import { notify } from "../shared/commands.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { SUMMARY_METHOD_DETAILS, summaryMethodOf } from "../shared/summary-method.ts";
import { archivePointer } from "./archive.ts";
import { cacheCold } from "./cache.ts";
import {
	SUMMARIZER_RESULT_CHARS,
	summarizerView,
	USER_MESSAGE_CHARS,
	USER_MESSAGES_CHARS,
	userMessagesSection,
} from "./checkpoint-text.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { carriedUserMessages, type FallbackContinuity, persistenceFailure } from "./continuity.ts";
import { keptWordsOf } from "./kept-words.ts";
import { carriedLoadedSkills, LOADED_SKILLS_DETAILS, loadedSkills, loadedSkillsLines } from "./loaded-skills.ts";
import { recordCompactionNote } from "./record.ts";
import {
	carriedSavedResults,
	SAVED_RESULTS_DETAILS,
	savedResultPaths,
	savedResultsBlock,
	withoutModelSavedResults,
} from "./saved-results.ts";
import { sessionCachePreferences, sharedSummary, type SummaryApi } from "./shared-summary.ts";
import { noGainReason } from "./summary-gain.ts";
import { SHARED_IMAGE_FOCUS, STANDALONE_IMAGE_FOCUS, SUMMARY_FOCUS, transcriptNote, userText } from "./summary-text.ts";

export { SUMMARIZER_RESULT_CHARS, summarizerView, USER_MESSAGE_CHARS, USER_MESSAGES_CHARS, userMessagesSection };
export { SHARED_IMAGE_FOCUS, STANDALONE_IMAGE_FOCUS, SUMMARY_FOCUS, transcriptNote, userText };

/**
 * The compaction summary. The model writes the checkpoint (`core/compaction/summary-format.ts`) with the focus below:
 * on the session's own model as one more request of the session, which the prompt cache holds (`shared-summary.ts`),
 * else (an overflow, a downshift, blocked images, any failure) through the exported `compact()` over the serialized
 * conversation (same cut point, split-turn handling, iterative update of the previous summary and file lists), routed
 * and cached as the session's requests are. Code, not the model, then appends the files Octocode saved from the
 * summarized results (`saved-results.ts`, carried like the file lists), the user's messages word for word (within a
 * budget, carried across compactions), the transcript that still holds every detail and the skills loaded so far
 * (`loaded-skills.ts`), and the backlog items this session holds and its running background work, read from the tools
 * (`live-state.ts`). Any failure
 * returns nothing, and Octocode writes its default summary; the same additions then follow it as one message
 * (`continuity.ts`).
 */

/**
 * Characters a compaction add-on may take of the window it lands in: `share` of what is left after Octocode's reserve, never
 * above `max`. Zero when the window is unknown-small, so a small model is not refilled to its threshold by what
 * compaction itself adds.
 */
export function windowBudget(
	contextWindow: number | undefined,
	reserveTokens: number,
	share: number,
	max: number,
): number {
	if (!contextWindow) return max;
	return Math.max(0, Math.min(max, Math.floor((contextWindow - reserveTokens) * CHARS_PER_TOKEN * share)));
}

/** Of the room after the reserve, the kept user messages take at most this share (a tenth: the summary and restored files need the rest). */
export const USER_MESSAGES_SHARE = 0.1;
/** The least room the user-message section gets: enough for the reference to their complete saved text. */
const USER_REFERENCE_CHARS = 1_000;

/**
 * Octocode carries the file lists of the previous summary forward only when Octocode wrote it; this summary is a hook's, so its
 * lists (the same `readFiles`/`modifiedFiles` details) are added back to the preparation here (in place).
 */
export function carryFileLists(
	preparation: Pick<SessionBeforeCompactEvent["preparation"], "fileOps">,
	branch: readonly SessionEntry[],
): void {
	const previous = [...branch].reverse().find((entry) => entry.type === "compaction");
	if (previous?.type !== "compaction" || !previous.fromHook || !isRecord(previous.details)) return;
	const strings = (value: unknown) =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	for (const file of strings(previous.details.readFiles)) preparation.fileOps.read.add(file);
	for (const file of strings(previous.details.modifiedFiles)) preparation.fileOps.edited.add(file);
}

/** The cache-sharing request was unusable: the summary is a standalone request over the serialized conversation, which the prompt cache does not hold. */
function notifyStandalone(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: string): void {
	if (ctx.hasUI)
		notify(
			ctx.ui,
			`Octocode could not write the compaction summary inside the session's cached request (${reason}); it sends the conversation again as a standalone request, which the prompt cache does not hold.`,
			"warning",
		);
}

export { SUMMARY_METHOD_DETAILS, summaryMethodOf };

/** The model's summary of one input, kept so a failure after the paid call does not repeat it. */
interface PaidSummary {
	key: string;
	result: CompactionResult;
	method: { method: string; reason?: string };
}

/** The last paid summary of each session (by its session manager). */
const paid = new WeakMap<object, PaidSummary>();

/** What a summary call depends on: the model and the span it summarizes. */
function paidKey(model: Model<Api>, preparation: CompactionPreparation, instructions?: string): string {
	return JSON.stringify([
		model.provider,
		model.id,
		preparation.firstKeptEntryId,
		preparation.tokensBefore,
		preparation.isSplitTurn,
		preparation.messagesToSummarize.length,
		preparation.turnPrefixMessages.length,
		preparation.previousSummary ?? null,
		instructions ?? null,
	]);
}

/**
 * What code appends after `summary` (the model's text): the saved-results block, the user's messages word for word
 * (the previous checkpoint's, then the summarized ones, within the budget) and the Recovery note. Sized for the window
 * the summary lands in (this session's model; after a downshift, the smaller one), and for what the inline summary has
 * left: messages that do not fit are saved whole behind a reference, so the summary itself stays inline instead of the
 * whole checkpoint becoming a file reference. A subagent's task, its oldest message, is the last to go.
 */
function codeSections(
	api: Pick<ExtensionAPI, "getActiveTools">,
	event: SessionBeforeCompactEvent,
	ctx: Pick<ExtensionContext, "model" | "sessionManager">,
	summary: string,
	previous: { messages: string[]; omitted: number },
	segment: number,
	saveText: ((text: string) => string | undefined) | null,
	parentId: string | undefined,
	liveState: (() => readonly string[]) | undefined,
): { saved: string[]; skills: ReturnType<typeof loadedSkills>; body: string; messages: string; note: string } {
	const summarized = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	// The user's messages, their askUser answers and, in a subagent, its parent's mail, each labeled by source.
	const added = summarized.flatMap((message) => userText(message) ?? keptWordsOf(message, parentId));
	const skills = loadedSkills(summarized, carriedLoadedSkills(event.branchEntries));
	const note = transcriptNote(
		ctx.sessionManager.getSessionFile(),
		api.getActiveTools().includes("backlogPlan"),
		archivePointer(segment),
		// The backlog and running work as the tools state them now, ahead of the skills line.
		[...(liveState?.() ?? []), ...loadedSkillsLines(skills)],
	);
	// Every file saved from the summarized results (and by earlier summaries), named once, like the file lists.
	const saved = savedResultPaths(
		summarized,
		clearedResults(event.branchEntries),
		carriedSavedResults(event.branchEntries),
	);
	const lists = saveText ? spillFileLists(summary, saveText) : summary;
	const body = `${withoutModelSavedResults(lists)}${savedResultsBlock(saved)}`;
	const reserveTokens = event.preparation.settings.reserveTokens;
	const inlineRoom = inlineSummaryTokens(reserveTokens) * CHARS_PER_TOKEN - body.length - note.length;
	const total = Math.min(
		windowBudget(ctx.model?.contextWindow, reserveTokens, USER_MESSAGES_SHARE, USER_MESSAGES_CHARS),
		Math.max(USER_REFERENCE_CHARS, inlineRoom),
	);
	const perMessage = Math.min(USER_MESSAGE_CHARS, Math.max(500, Math.floor(total / 4)));
	const messages = userMessagesSection(
		previous.messages,
		previous.omitted,
		added,
		// A subagent's task is its whole assignment and often runs past a user's message: half the section may hold it.
		parentId === undefined
			? { total, perMessage }
			: { total, perMessage: Math.max(perMessage, Math.floor(total / 2)), keepOldest: true },
		segment,
		saveText,
	);
	return { saved, skills, body, messages, note };
}

/**
 * Octocode's compaction result, or undefined to let Octocode write its default summary (the reason is recorded in the
 * session). When Octocode's summary requests failed, `fallback` holds the sections code appends, for that summary.
 */
export async function writeSummary(
	api: SummaryApi,
	event: SessionBeforeCompactEvent,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "hasUI" | "ui">,
	summaryModel?: Model<Api>,
	fallback?: FallbackContinuity,
	/** The agent that started this one, when it is a subagent: its mail to this agent is kept word for word. */
	parentId?: string,
	/** The lifetime of the session's history cache entry (`promptCacheTtlMs`): past it, the shared request does not cache its history. */
	cacheTtlMs?: number,
	/** The Recovery lines for the state the tools report (`live-state.ts`), read when the summary is written, never from the model. */
	liveState?: () => readonly string[],
	/** The lifetime of the instruction entry when it outlives the history's (`long` tier); the history's when omitted. */
	instructionTtlMs?: number,
): Promise<NativeCompactionResult | undefined> {
	// A compaction before a downshift summarizes on the model the context still fits.
	const model = summaryModel ?? ctx.model;
	if (event.signal.aborted) return undefined;
	if (!model) {
		recordCompactionNote(api, "default-summary", "no model is selected for the summary");
		return undefined;
	}
	// The archive writes this compaction's messages as the next segment once it succeeds (`register.ts`).
	const segment = nextSegment();
	// An in-memory session has no file to save to: long texts stay inline, cut with a marker.
	const sessionFile = ctx.sessionManager.getSessionFile();
	const saveText = sessionFile ? (text: string) => persistCheckpointText(text, sessionFile) : null;
	// The model updates only its own part of the previous summary; code carries the user messages and the note.
	const previous =
		event.preparation.previousSummary === undefined ? undefined : splitSummary(event.preparation.previousSummary);
	const kept = carriedUserMessages(previous, event.branchEntries);
	const automatic = event.reason === "threshold" || event.reason === "overflow";
	try {
		// Through the model registry, as Octocode's own session streams: request-time auth, and providers an extension registered.
		const recordUsage = api.createUsageRecorder("compaction_attempt");
		const stream = (request: typeof model, context: Context, options?: SimpleStreamOptions) => {
			const response = ctx.modelRegistry.streamSimple(request, context, options);
			const result = response.result().then((message) => {
				recordUsage(message);
				return message;
			});
			response.result = () => result;
			return response;
		};
		const instructions = (images: string) =>
			`${SUMMARY_FOCUS} ${images}${event.customInstructions ? `\n\nAdditional user focus:\n${event.customInstructions}` : ""}`;
		// The standalone request's view of the messages: long tool results are saved whole and shown as references. Only
		// that request reads it (the shared one reads the session's own messages), so it is built only when it is sent.
		const standalonePreparation = () => ({
			...event.preparation,
			messagesToSummarize: summarizerView(event.preparation.messagesToSummarize, segment, saveText),
			turnPrefixMessages: summarizerView(event.preparation.turnPrefixMessages, segment, saveText),
			...(previous === undefined ? {} : { previousSummary: previous.body }),
		});
		const key = paidKey(model, event.preparation, event.customInstructions);
		let paidSummary = paid.get(ctx.sessionManager);
		if (paidSummary?.key !== key) {
			// An automatic compaction whose appended sections alone (unsaved) are as large as what the summary replaces cannot
			// free anything, so the model is not paid to write it.
			if (automatic) {
				const floor = codeSections(api, event, ctx, "", kept, segment, null, parentId, liveState);
				const futile = noGainReason(event.preparation, `${floor.body}${floor.messages}${floor.note}`);
				if (futile) return { cancel: true, failure: futile };
			}
			// On the session's own model the summary is asked for inside the session's request, which the prompt cache holds;
			// on another (a downshift) or when that fails, as a standalone request over the serialized conversation. After an
			// overflow the session's own request just failed for its size: sharing it would only fail again.
			const share = summaryModel === undefined && event.reason !== "overflow";
			let fallback =
				summaryModel !== undefined
					? `the summary ran on ${model.id}, the model before a downshift, not the session's own`
					: event.reason === "overflow"
						? "the context had overflowed the model's window, so sharing it would overflow again"
						: "the cache-sharing request was cancelled";
			const shared = share
				? await sharedSummary(
						api,
						event,
						ctx,
						model,
						instructions(SHARED_IMAGE_FOCUS),
						(reason, userChoice) => {
							fallback = reason;
							if (!userChoice) notifyStandalone(ctx, reason);
						},
						recordUsage,
						cacheCold(ctx.sessionManager, cacheTtlMs),
						cacheCold(ctx.sessionManager, instructionTtlMs ?? cacheTtlMs),
					)
				: undefined;
			// Passes the session's preferences with history `none`, so octocode-ai sends no cache markers and the adapters drop
			// their cache routing id (OpenCode still gets its `x-opencode-session` header, which its gateway requires): its
			// prompt (the summarizer's system prompt over the serialized conversation) is never sent again, so nothing would read
			// what it wrote.
			const written =
				shared ??
				(await compact(
					standalonePreparation(),
					model,
					undefined,
					undefined,
					instructions(STANDALONE_IMAGE_FOCUS),
					event.signal,
					api.getThinkingLevel(),
					stream,
					undefined,
					undefined,
					undefined,
					ctx.sessionManager.getSessionId(),
					{ ...sessionCachePreferences(ctx, model, api.getSettings()), cacheRetention: "none" },
				));
			// A cancelled compaction saves nothing, so a summary that returned after the cancel is not kept either.
			if (event.signal.aborted) return undefined;
			// Kept until the same input is summarized again: a failure after this call must not make the next turn pay again.
			paidSummary = {
				key,
				result: written,
				method: shared ? { method: "cache-shared" } : { method: "standalone", reason: fallback },
			};
			paid.set(ctx.sessionManager, paidSummary);
		}
		const { result, method } = paidSummary;
		const { saved, skills, body, messages, note } = codeSections(
			api,
			event,
			ctx,
			result.summary,
			kept,
			segment,
			saveText,
			parentId,
			liveState,
		);
		// An automatic compaction that frees nothing is not committed: the next one would only come sooner. A manual one
		// is the user's (or the agent's `compact`) request, and commits.
		const futile = automatic ? noGainReason(event.preparation, `${body}${messages}${note}`) : undefined;
		if (futile) return { cancel: true, failure: futile };
		const details = {
			...asRecord(result.details),
			...(saved.length > 0 ? { [SAVED_RESULTS_DETAILS]: saved } : {}),
			...(skills.length > 0 ? { [LOADED_SKILLS_DETAILS]: skills } : {}),
			[SUMMARY_METHOD_DETAILS]: method,
		};
		return {
			compaction: {
				...result,
				usage: undefined,
				summary: `${body}${messages}${note}`,
				details,
			},
		};
	} catch (error) {
		const failed = persistenceFailure(api, ctx, error);
		if (failed) return failed;
		if (event.signal.aborted) return undefined;
		// Octocode's default summary has none of what code appends: built now, from the same inputs and budgets, it follows
		// that summary as one message (`continuity.ts`). Saving its long texts can fail like Octocode's summary does.
		if (fallback) {
			try {
				const { body, messages, note } = codeSections(
					api,
					event,
					ctx,
					"",
					kept,
					segment,
					saveText,
					parentId,
					liveState,
				);
				fallback.hold(event.preparation.firstKeptEntryId, `${body}${messages}${note}`);
			} catch (sectionsError) {
				const sectionsFailed = persistenceFailure(api, ctx, sectionsError);
				if (sectionsFailed) return sectionsFailed;
				fallback.discard();
			}
		}
		recordCompactionNote(api, "default-summary", `Octocode's compaction summary failed (${errorMessage(error)})`);
		if (ctx.hasUI)
			notify(
				ctx.ui,
				`Octocode's compaction summary failed (${errorMessage(error)}); Octocode writes its default summary.`,
				"warning",
			);
		return undefined;
	}
}
