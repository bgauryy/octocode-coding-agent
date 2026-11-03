import type { NativeCompactionResult } from "../../core/compaction/native-result.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	inlineSummaryTokens,
	persistCheckpointText,
} from "../../core/compaction/index.ts";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { clearedResults } from "../files/reads.ts";
import { nextSegment } from "../shared/archive.ts";
import { notify } from "../shared/commands.ts";
import { tildePath } from "../shared/home.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { contentText } from "../shared/util.ts";
import { SUMMARY_METHOD_DETAILS, summaryMethodOf } from "../shared/summary-method.ts";
import { archivePointer } from "./archive.ts";
import {
	SUMMARIZER_RESULT_CHARS,
	summarizerView,
	USER_MESSAGE_CHARS,
	USER_MESSAGES_CHARS,
	userMessagesSection,
} from "./checkpoint-text.ts";
import { RECOVERY_HEADING, splitSummary } from "../../core/compaction/summary-view.ts";
import { carriedUserMessages, type FallbackContinuity, persistenceFailure } from "./continuity.ts";
import { keptWordsOf } from "./kept-words.ts";
import { recordCompactionNote } from "./record.ts";
import {
	carriedSavedResults,
	SAVED_RESULTS_DETAILS,
	savedResultPaths,
	savedResultsBlock,
	withoutModelSavedResults,
} from "./saved-results.ts";
import { sessionCachePreferences, sharedSummary } from "./shared-summary.ts";

export { SUMMARIZER_RESULT_CHARS, summarizerView, USER_MESSAGE_CHARS, USER_MESSAGES_CHARS, userMessagesSection };

/**
 * The compaction summary. The model writes the checkpoint (`core/compaction/summary-format.ts`) with the focus below:
 * on the session's own model as one more request of the session, which the prompt cache holds (`shared-summary.ts`),
 * else (an overflow, a downshift, blocked images, any failure) through the exported `compact()` over the serialized
 * conversation (same cut point, split-turn handling, iterative update of the previous summary and file lists), routed
 * and cached as the session's requests are. Code, not the model, then appends the files Octocode saved from the
 * summarized results (`saved-results.ts`, carried like the file lists), the user's messages word for word (newest
 * first within a budget, carried across compactions), and the transcript that still holds every detail. Any failure
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
 * Sent with every summary request as its "Additional focus": how to judge what to keep. The sections are the checkpoint
 * format the request already carries, and what code appends after the summary (the user's messages, file lists, saved
 * results, recovery pointers) is not asked for.
 */
export const SUMMARY_FOCUS = `This summary becomes the only record of the conversation above: the next model will not see those messages, and what the summary leaves out it will not know to look for. Code appends the user's messages word for word after your summary, with their askUser answers and, for a subagent, its parent's messages, so do not quote whole messages; state what they asked for, decided and corrected, and keep each limit, number, path, identifier and prohibition the user set exactly as written, and every approval or permission the user granted, with its scope. Condense the assistant's own reasoning and narration, but keep what the work found exactly: numbers, sizes, lists, names, states, error strings and conclusions. Detail that can be fetched again (a file, a command's output, a page) needs only a pointer: its path, command or URL. Images do not reach you: where the messages show an image was read, attached or captured, keep its path and what was said about it. Write only what the messages show; never guess.`;

/**
 * Where the summarized messages stay verbatim, appended to the summary so exact details are read, not guessed: the
 * archive's lines first (`archivePointer`; none when this session cannot archive), the session's transcript (the
 * archive's fallback, or the whole answer when there is no archive) and the backlog. Every line is one `- ` bullet:
 * `splitSummary` removes the section by that shape when the summary is rewritten.
 */
export function transcriptNote(
	sessionFile: string | undefined,
	backlog: boolean,
	archive: readonly string[] = [],
): string {
	const transcript = sessionFile ? tildePath(sessionFile) : undefined;
	const lines = [
		...archive,
		...(transcript
			? [
					archive.length > 0
						? `If the archive does not have it, the full transcript is ${transcript} (JSONL, one entry per line).`
						: `The full transcript before this summary is ${transcript} (JSONL, one entry per line): search it for an exact message, error or tool result instead of guessing.`,
				]
			: []),
		...(backlog
			? [
					"Record a follow-up that must outlive this session with `backlog`, with its goal and why; `steps list` shows open steps.",
				]
			: []),
	];
	return lines.length > 0 ? `\n\n${RECOVERY_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/**
 * A skill Octocode expanded into the user message (`/skill:name args` becomes `<skill name="…" location="…">body</skill>`
 * then the args): the body is a file the next model can read again, not the user's words.
 */
const SKILL_BLOCK = /<skill name="([^"\n]*)" location="([^"\n]*)">\n[\s\S]*?\n<\/skill>/g;

/**
 * A user message's text as the model saw it: its text parts, a marker for each attached image, and each expanded
 * skill as a pointer to its file (`[skill name loaded from path]`), so a skill body does not take the user's budget.
 */
export function userText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const text = contentText(message.content, { image: "[image attached]" });
	return text === ""
		? undefined
		: text.replace(SKILL_BLOCK, (_, name: string, location: string) => `[skill ${name} loaded from ${location}]`);
}

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
 * (the previous checkpoint's, then the summarized ones, newest first within the budget) and the Recovery note. Sized for
 * the window the summary lands in (this session's model; after a downshift, the smaller one), and for what the inline
 * summary has left: messages that do not fit are saved whole behind a reference, so the summary itself stays inline
 * instead of the whole checkpoint becoming a file reference.
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
): { saved: string[]; body: string; messages: string; note: string } {
	const summarized = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	// The user's messages, their askUser answers and, in a subagent, its parent's mail, each labeled by source.
	const added = summarized.flatMap((message) => userText(message) ?? keptWordsOf(message, parentId));
	const note = transcriptNote(
		ctx.sessionManager.getSessionFile(),
		api.getActiveTools().includes("backlog"),
		archivePointer(segment),
	);
	// Every file saved from the summarized results (and by earlier summaries), named once, like the file lists.
	const saved = savedResultPaths(
		summarized,
		clearedResults(event.branchEntries),
		carriedSavedResults(event.branchEntries),
	);
	const body = `${withoutModelSavedResults(summary)}${savedResultsBlock(saved)}`;
	const reserveTokens = event.preparation.settings.reserveTokens;
	const inlineRoom = inlineSummaryTokens(reserveTokens) * CHARS_PER_TOKEN - body.length - note.length;
	const total = Math.min(
		windowBudget(ctx.model?.contextWindow, reserveTokens, USER_MESSAGES_SHARE, USER_MESSAGES_CHARS),
		Math.max(USER_REFERENCE_CHARS, inlineRoom),
	);
	const messages = userMessagesSection(
		previous.messages,
		previous.omitted,
		added,
		{ total, perMessage: Math.min(USER_MESSAGE_CHARS, Math.max(500, Math.floor(total / 4))) },
		segment,
		saveText,
	);
	return { saved, body, messages, note };
}

/**
 * Octocode's compaction result, or undefined to let Octocode write its default summary (the reason is recorded in the
 * session). When Octocode's summary requests failed, `fallback` holds the sections code appends, for that summary.
 */
export async function writeSummary(
	api: Pick<
		ExtensionAPI,
		"getThinkingLevel" | "getActiveTools" | "getSettings" | "appendEntry" | "createUsageRecorder"
	>,
	event: SessionBeforeCompactEvent,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "hasUI" | "ui">,
	summaryModel?: Model<Api>,
	/**
	 * `cacheCold` (the session's prompt cache is past its lifetime) no longer changes the choice: the session's next
	 * request rewrites the prefix anyway, so the shared request pays that write once and the next request reads it.
	 */
	fallback?: FallbackContinuity,
	/** The agent that started this one, when it is a subagent: its mail to this agent is kept word for word. */
	parentId?: string,
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
		const instructions = event.customInstructions
			? `${SUMMARY_FOCUS}\n\nAdditional user focus:\n${event.customInstructions}`
			: SUMMARY_FOCUS;
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
			// On the session's own model the summary is asked for inside the session's request, which the prompt cache holds
			// (or is about to hold again); on another (a downshift) or when that fails, as a standalone request over the
			// serialized conversation. After an overflow the session's own request just failed for its size: sharing it
			// would only fail again.
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
						instructions,
						(reason, userChoice) => {
							fallback = reason;
							if (!userChoice) notifyStandalone(ctx, reason);
						},
						recordUsage,
					)
				: undefined;
			// Routed and cached as the session's own requests, so a provider that routes by session keeps it with them.
			const written =
				shared ??
				(await compact(
					standalonePreparation(),
					model,
					undefined,
					undefined,
					instructions,
					event.signal,
					api.getThinkingLevel(),
					stream,
					undefined,
					undefined,
					undefined,
					ctx.sessionManager.getSessionId(),
					sessionCachePreferences(ctx, model, api.getSettings()),
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
		const { saved, body, messages, note } = codeSections(
			api,
			event,
			ctx,
			result.summary,
			kept,
			segment,
			saveText,
			parentId,
		);
		const details = {
			...asRecord(result.details),
			...(saved.length > 0 ? { [SAVED_RESULTS_DETAILS]: saved } : {}),
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
				const { body, messages, note } = codeSections(api, event, ctx, "", kept, segment, saveText, parentId);
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
