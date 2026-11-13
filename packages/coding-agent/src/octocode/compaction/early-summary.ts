/**
 * The compaction summary requested ahead of the threshold (`session_compact_prewarm`), so the compaction that follows
 * does not hold the turn while the model writes it.
 *
 * Only the cache-sharing request is sent early (`shared-summary.ts`): it reads the session's cached prefix, as the
 * compaction's own request would. When it cannot be used, nothing is kept and the compaction requests its summary as
 * it always did. The compaction takes the early summary only for the same plan (model, cut point, summarized messages
 * and thinking level). The file lists are rebuilt then, since the run may have touched files in between.
 *
 * Each step leaves a note in the session (`record.ts`, kind `early-summary`): requested, ready, or why it cannot be
 * used. The compaction entry says in its `details` that its summary was requested early and how long it waited.
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import type { CompactionPreparation, CompactionResult } from "../../core/compaction/index.ts";
import { computeFileLists, formatFileOperations } from "../../core/compaction/utils.ts";
import type { ExtensionContext, SessionCompactPrewarmEvent } from "../../core/features/index.ts";
import { recordCompactionNote } from "./record.ts";
import { sharedSummary, type SummaryApi } from "./shared-summary.ts";
import { SHARED_IMAGE_FOCUS, SUMMARY_FOCUS } from "./summary-text.ts";

interface EarlySummary {
	plan: string;
	signal: AbortSignal;
	requestedAt: number;
	/** The summary and the file lists it ends with, or undefined when the request failed, was unusable or was aborted. */
	written: Promise<{ result: CompactionResult; lists: string } | undefined>;
}

/** The early summary of each session (by its session manager). */
const early = new WeakMap<object, EarlySummary>();

/** What the summary text depends on: unlike the paid-summary key, not the file lists or the token count, which move on. */
function planOf(model: Model<Api>, preparation: CompactionPreparation, thinking: string, forced?: string): string {
	return sha256(
		JSON.stringify([
			model.provider,
			model.id,
			model.api,
			model.contextWindow,
			model.maxTokens,
			preparation.firstKeptEntryId,
			preparation.isSplitTurn,
			preparation.messagesToSummarize,
			preparation.turnPrefixMessages,
			preparation.previousSummary ?? null,
			preparation.settings.reserveTokens,
			thinking,
			forced,
		]),
	);
}

const fileLists = (preparation: CompactionPreparation) => {
	const lists = computeFileLists(preparation.fileOps);
	return { lists, text: formatFileOperations(lists.readFiles, lists.modifiedFiles) };
};

/**
 * Sends the cache-sharing summary request for the event's plan and keeps its result for `takeEarlySummary`. Not awaited
 * by the caller. `cold`: the session's cache entry has expired, so the request would bill the whole input beside the
 * run; it is left to the compaction.
 */
export function startEarlySummary(
	api: SummaryApi,
	event: SessionCompactPrewarmEvent,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">,
	cold: boolean,
): void {
	const model = ctx.model;
	if (!model || cold || event.signal.aborted) return;
	const { preparation, signal } = event;
	const recordUsage = api.createUsageRecorder("compaction_attempt");
	const requestedAt = Date.now();
	const note = (text: string) => {
		if (!signal.aborted) recordCompactionNote(api, "early-summary", text);
	};
	note(
		`requested the compaction summary ahead of the threshold, beside the run (about ${preparation.tokensBefore.toLocaleString("en-US")} tokens in context)`,
	);
	let unusable: string | undefined;
	const written = sharedSummary(
		api,
		event,
		ctx,
		model,
		`${SUMMARY_FOCUS} ${SHARED_IMAGE_FOCUS}`,
		(reason) => {
			unusable = reason;
		},
		// The recorder captured its originating session; dropping a plan does not undo reported spend.
		recordUsage,
		false,
		false,
		// Background requests only read a reusable prefix; history rewrites can make it cold after the TTL check.
		true,
	)
		.then((result) => {
			const seconds = ((Date.now() - requestedAt) / 1000).toFixed(1);
			if (!result)
				note(`the early summary cannot be used (${unusable ?? "cancelled"}); the compaction requests its own`);
			if (!result || signal.aborted) return undefined;
			note(`the early summary is ready after ${seconds} s; the compaction uses it without waiting`);
			return { result, lists: fileLists(preparation).text };
		})
		.catch(() => undefined);
	const plan = planOf(model, preparation, api.getThinkingLevel(), event.summaryRequest?.forceSystemPrompt);
	early.set(ctx.sessionManager, { plan, signal, requestedAt, written });
}

/**
 * The early summary for this plan, waited for when it is still being written; undefined when there is none, it is for
 * another plan, it failed or `signal` aborts first. Taken once: the caller keeps it as its paid summary. `early` says
 * when it was requested and how long this call waited for it (0: it was ready).
 */
export async function takeEarlySummary(
	sessionManager: object,
	model: Model<Api>,
	preparation: CompactionPreparation,
	thinking: string,
	signal: AbortSignal,
	forcedSystemPrompt?: string,
): Promise<{ result: CompactionResult; early: { requestedAt: string; waitedMs: number } } | undefined> {
	const entry = early.get(sessionManager);
	if (!entry) return undefined;
	early.delete(sessionManager);
	if (signal.aborted || entry.signal.aborted || entry.plan !== planOf(model, preparation, thinking, forcedSystemPrompt))
		return undefined;
	let stop: (() => void) | undefined;
	const aborted = new Promise<undefined>((resolve) => {
		stop = () => resolve(undefined);
		signal.addEventListener("abort", stop, { once: true });
		entry.signal.addEventListener("abort", stop, { once: true });
	});
	const waitingSince = Date.now();
	const written = await Promise.race([entry.written, aborted]);
	const waitedMs = Date.now() - waitingSince;
	if (stop) {
		signal.removeEventListener("abort", stop);
		entry.signal.removeEventListener("abort", stop);
	}
	if (!written || signal.aborted || entry.signal.aborted || !written.result.summary.endsWith(written.lists))
		return undefined;
	const text = written.result.summary.slice(0, written.result.summary.length - written.lists.length);
	const now = fileLists(preparation);
	return {
		result: {
			...written.result,
			summary: `${text}${now.text}`,
			tokensBefore: preparation.tokensBefore,
			details: now.lists,
		},
		early: { requestedAt: new Date(entry.requestedAt).toISOString(), waitedMs },
	};
}
