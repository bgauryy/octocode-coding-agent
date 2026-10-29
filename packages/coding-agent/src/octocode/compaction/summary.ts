import { UsagePersistenceError } from "../../core/usage-totals.ts";
import type { NativeCompactionResult } from "../../core/compaction/native-result.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	CheckpointPersistenceError,
	compact,
	inlineSummaryTokens,
	persistCheckpointText,
} from "../../core/compaction/index.ts";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../core/extensions/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { clearedResults } from "../files/reads.ts";
import { nextSegment } from "../shared/archive.ts";
import { notify } from "../shared/commands.ts";
import { tildePath } from "../shared/home.ts";
import { CHARS_PER_TOKEN } from "../../core/compaction/tokens.ts";
import { errorMessage, isRecord } from "../../utils/guards.ts";
import { contentText, escapeRegExp } from "../shared/util.ts";
import { archivePointer, TLDR_HEADING, TOPICS_LABEL } from "./archive.ts";
import {
	SUMMARIZER_RESULT_CHARS,
	summarizerView,
	USER_HEADING,
	USER_MESSAGE_CHARS,
	USER_MESSAGES_CHARS,
	userMessagesSection,
} from "./checkpoint-text.ts";
import { recordCompactionNote } from "./record.ts";
import {
	carriedSavedResults,
	SAVED_RESULTS_DETAILS,
	savedResultPaths,
	savedResultsBlock,
	withoutModelSavedResults,
	withoutSavedResults,
} from "./saved-results.ts";
import { sharedSummary } from "./shared-summary.ts";

export { SUMMARIZER_RESULT_CHARS, summarizerView, USER_MESSAGE_CHARS, USER_MESSAGES_CHARS, userMessagesSection };

/**
 * The compaction summary. Octocode's own summary (goal, constraints, progress, decisions, next steps, critical context, file
 * lists) loses what a resumed agent most needs verbatim: the user's own words, the errors already solved, and where
 * the work stopped. Octocode gives a hook no way to add to its prompt, so Octocode writes the summary itself: on the
 * session's own model as a request the prompt cache already holds (`shared-summary.ts`), else (a downshift, blocked
 * images, any failure) through Octocode's exported `compact()` (same cut point, split-turn handling, iterative update of the
 * previous summary and file lists), with the same built-in focus in both. Code, not the model, then appends the files Octocode saved from the summarized results
 * (`saved-results.ts`, carried like the file lists), the user's messages word for word (newest first within a budget, carried across
 * compactions), and the transcript that still holds every detail. Any failure returns nothing, and Octocode writes its default summary.
 * (Octocode's default summary has none of these additions.)
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

const RECOVERY_HEADING = "## Recovery";

/** Appended to Octocode's summarization prompt (after its fixed sections, as "Additional focus"). */
export const SUMMARY_FOCUS = `This summary becomes the only record of the conversation above: the next model will not see those messages, and what the summary leaves out it will not know to look for. The user's messages are appended after your summary word for word by code, so do not copy them; state what they ask, decided and corrected. Condense the assistant's own reasoning and narration, but keep what the work found exactly: numbers, sizes, lists, names, states, error strings and conclusions. Detail that can be fetched again (a file, a command's output, a page) needs only a pointer: its path, command or URL. Images do not reach you: where the messages show an image was read, attached or captured, keep its path and what was said about it.

Also add these sections after "## Critical Context", in this order:

## Errors & Fixes
- Each error or failed approach: the exact error text, its cause, and the fix, or "unresolved". Include the user's corrections of your approach.

## Where We Stopped
- The work under way in the last messages above, with exact file paths, and a verbatim quote of the latest user request and of the assistant's last step. Name a next step only if it follows directly from that request; never start tangential work.

## Follow-ups
- Work promised, deferred or suggested but not started, and open questions for the user, or "(none)".

${TLDR_HEADING}
One or two lines on what the messages above did (only those, not the earlier summary), then a line "${TOPICS_LABEL} " with 3 to 8 comma-separated keywords. An index of the conversation's history uses it as this stretch's label.

Everywhere, keep file paths, symbols, commands, error strings, URLs and identifiers exact. When updating a previous summary, keep the entries of these sections and add the new ones (except ${TLDR_HEADING}: write it afresh for the messages above); newer messages win where they contradict, resolve or supersede it. Write only what the messages show; never guess.`;

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
		...(backlog ? ["Record follow-ups that must outlive this session with `backlog`."] : []),
	];
	return lines.length > 0 ? `\n\n${RECOVERY_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/** A summary split into the model's part and what code appended: the kept user messages (oldest first) and how many older ones were left out. */
interface SplitSummary {
	body: string;
	messages: string[];
	omitted: number;
}

/** Code appends the file lists after the summary from the compaction's details (see `carryFileLists`), never the model. */
const FILE_LIST_BLOCKS = /\n\n<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>/g;

/** Splits a summary this module wrote; any other summary is all body. The body never keeps code-appended file lists. */
export function splitSummary(summary: string): SplitSummary {
	const recovered = summary.replace(new RegExp(`\\n\\n${RECOVERY_HEADING}\\n(?:- [^\\n]*(?:\\n|$))+$`), "");
	const modelPart = (text: string) => withoutSavedResults(text).replace(FILE_LIST_BLOCKS, "");
	const at = recovered.lastIndexOf(`\n\n${USER_HEADING}\n`);
	if (at < 0) return { body: modelPart(recovered), messages: [], omitted: 0 };
	const section = recovered.slice(at);
	const body = modelPart(recovered.slice(0, at));
	const messages = [...section.matchAll(/<user-message>\n([\s\S]*?)\n<\/user-message>/g)].map((match) => match[1]);
	const omitted = Number(
		new RegExp(`^\\n\\n${escapeRegExp(USER_HEADING)}\\nEarlier user messages not kept here: (\\d+)`).exec(
			section,
		)?.[1] ?? 0,
	);
	return { body, messages, omitted };
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

/** The cache-sharing request was unusable: the summary is written as a standalone request, which bills the whole input. */
function notifyStandalone(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: string): void {
	if (ctx.hasUI)
		notify(
			ctx.ui,
			`Octocode could not write the compaction summary from the prompt cache (${reason}); it uses a standalone request that pays for the whole input.`,
			"warning",
		);
}

/**
 * The compaction `details` key that names how this summary was written: `{ method: 'cache-shared' }`, or
 * `{ method: 'standalone', reason }` with why the cache-sharing request was not used. Without it the method could
 * only be guessed from the cache numbers of the request.
 */
export const SUMMARY_METHOD_DETAILS = "summaryMethod";

/** How Octocode wrote the summary of a compaction entry's `details` (`cache-shared`, `standalone`); undefined when it did not (Octocode's default summary, another extension's). */
export function summaryMethodOf(details: unknown): string | undefined {
	const method =
		isRecord(details) && isRecord(details[SUMMARY_METHOD_DETAILS]) ? details[SUMMARY_METHOD_DETAILS].method : undefined;
	return typeof method === "string" ? method : undefined;
}

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

/** Octocode's compaction result, or undefined to let Octocode write its default summary (the reason is recorded in the session). */
export async function writeSummary(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "getActiveTools" | "getSettings" | "appendEntry" | "createUsageRecorder">,
	event: SessionBeforeCompactEvent,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "hasUI" | "ui">,
	summaryModel?: Model<Api>,
	/** `cacheCold`: the session's prompt cache is past its lifetime, so sharing it would pay to rewrite it, not read it. */
	options: { cacheCold?: boolean } = {},
): Promise<NativeCompactionResult | undefined> {
	// A compaction before a downshift summarizes on the model the context still fits.
	const model = summaryModel ?? ctx.model;
	if (event.signal.aborted) return undefined;
	if (!model) {
		recordCompactionNote(pi, "default-summary", "no model is selected for the summary");
		return undefined;
	}
	try {
		// Through the model registry, as Octocode's own session streams: request-time auth, and providers an extension registered.
		const recordUsage = pi.createUsageRecorder("compaction_attempt");
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
		// The archive writes this compaction's messages as the next segment once it succeeds (`register.ts`).
		const segment = nextSegment();
		// An in-memory session has no file to save to: long texts stay inline, cut with a marker.
		const sessionFile = ctx.sessionManager.getSessionFile();
		const saveText = sessionFile ? (text: string) => persistCheckpointText(text, sessionFile) : null;
		// The model updates only its own part of the previous summary; code carries the user messages and the note.
		const previous =
			event.preparation.previousSummary === undefined ? undefined : splitSummary(event.preparation.previousSummary);
		const preparation = {
			...event.preparation,
			messagesToSummarize: summarizerView(event.preparation.messagesToSummarize, segment, saveText),
			turnPrefixMessages: summarizerView(event.preparation.turnPrefixMessages, segment, saveText),
			...(previous === undefined ? {} : { previousSummary: previous.body }),
		};
		const key = paidKey(model, event.preparation, event.customInstructions);
		let paidSummary = paid.get(ctx.sessionManager);
		if (paidSummary?.key !== key) {
			// On the session's own model the summary is asked for inside the session's request, which the prompt cache already
			// holds; on another (a downshift) or when that fails, as a standalone request that pays for the whole input.
			// After an overflow the session's own request just failed for its size: sharing it would only fail again.
			const share = summaryModel === undefined && options.cacheCold !== true && event.reason !== "overflow";
			let fallback =
				summaryModel !== undefined
					? `the summary ran on ${model.id}, the model before a downshift, not the session's own`
					: event.reason === "overflow"
						? "the context had overflowed the model's window, so sharing it would overflow again"
						: share
							? "the cache-sharing request was cancelled"
							: "the prompt cache had expired, so sharing it would rewrite the whole context";
			const shared = share
				? await sharedSummary(
						pi,
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
			const written =
				shared ??
				(await compact(
					preparation,
					model,
					undefined,
					undefined,
					instructions,
					event.signal,
					pi.getThinkingLevel(),
					stream,
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
		const added = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages].flatMap(
			(message) => userText(message) ?? [],
		);
		const note = transcriptNote(
			ctx.sessionManager.getSessionFile(),
			pi.getActiveTools().includes("backlog"),
			archivePointer(segment),
		);
		// Every file saved from the summarized results (and by earlier summaries), named once, like the file lists.
		const saved = savedResultPaths(
			[...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
			clearedResults(event.branchEntries),
			carriedSavedResults(event.branchEntries),
		);
		const body = `${withoutModelSavedResults(result.summary)}${savedResultsBlock(saved)}`;
		// Sized for the window the summary lands in (this session's model; after a downshift, the smaller one), and for
		// what the inline summary has left: messages that do not fit are saved whole behind a reference, so the summary
		// itself stays inline instead of the whole checkpoint becoming a file reference.
		const reserveTokens = event.preparation.settings.reserveTokens;
		const inlineRoom = inlineSummaryTokens(reserveTokens) * CHARS_PER_TOKEN - body.length - note.length;
		const total = Math.min(
			windowBudget(ctx.model?.contextWindow, reserveTokens, USER_MESSAGES_SHARE, USER_MESSAGES_CHARS),
			Math.max(USER_REFERENCE_CHARS, inlineRoom),
		);
		const messages = userMessagesSection(
			previous?.messages ?? [],
			previous?.omitted ?? 0,
			added,
			{ total, perMessage: Math.min(USER_MESSAGE_CHARS, Math.max(500, Math.floor(total / 4))) },
			segment,
			saveText,
		);
		const details = {
			...(isRecord(result.details) ? result.details : {}),
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
		if (error instanceof CheckpointPersistenceError || error instanceof UsagePersistenceError) {
			recordCompactionNote(pi, "checkpoint-not-saved", error.message);
			if (ctx.hasUI) notify(ctx.ui, error.message, "error");
			// Not the user's cancel: a failure, so the automatic failure limit counts it.
			return { cancel: true, failure: error.message };
		}
		if (event.signal.aborted) return undefined;
		recordCompactionNote(pi, "default-summary", `Octocode's compaction summary failed (${errorMessage(error)})`);
		if (ctx.hasUI)
			notify(
				ctx.ui,
				`Octocode's compaction summary failed (${errorMessage(error)}); Octocode writes its default summary.`,
				"warning",
			);
		return undefined;
	}
}
