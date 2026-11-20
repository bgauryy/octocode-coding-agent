/**
 * The compaction summary requested ahead of the threshold (`session_compact_prewarm`), so the compaction that follows
 * does not hold the turn while the model writes it. The threshold compaction takes it, and so does the agent's own
 * request (its `compact` tool at a task boundary), which runs the same plan: its focus then reaches the agent after the
 * compaction instead of a new summary being paid for.
 *
 * Only the cache-sharing request is sent early (`shared-summary.ts`): it reads the session's cached prefix, as the
 * compaction's own request would. When it cannot be used, nothing is kept and the compaction requests its summary as
 * it always did. The compaction takes the early summary only for the same plan (model, cut point, summarized messages
 * and thinking level). The file lists are rebuilt then, since the run may have touched files in between.
 *
 * Each step leaves a note in the session (`record.ts`, kind `early-summary`): requested, ready, why it cannot be used,
 * and, when the compaction does not take it or a newer plan replaces it, that it was discarded and whether its request
 * had finished (billed) or was still running, so speculative spend that bought nothing can be counted. The compaction
 * entry says in its `details` that its summary was requested early, how long it waited, and which usage entries paid
 * for it.
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { CompactionPreparation, CompactionResult } from "../../core/compaction/index.ts";
import { ATTEMPT_IDS_DETAILS, compactionAttemptIds } from "../../core/compaction/outcome.ts";
import { computeFileLists, formatFileOperations } from "../../core/compaction/utils.ts";
import type {
	FeatureContext,
	SessionBeforeCompactEvent,
	SessionCompactPrewarmEvent,
	SetupPick,
} from "../../core/features/index.ts";
import { type PrewarmWatch, prewarmWatchOf } from "../monitor/attention/prewarm.ts";
import { recordCompactionNote } from "./record.ts";
import { sharedSummary, type SummaryApi } from "./shared-summary.ts";

interface EarlySummary {
	plan: string;
	signal: AbortSignal;
	requestedAt: number;
	/** The summary and the file lists it ends with, or undefined when the request failed, was unusable or was aborted. */
	written: Promise<{ result: CompactionResult; lists: string } | undefined>;
	/** The request has ended (with or without a usable summary). */
	settled: boolean;
	/** Stops the request this entry owns; the event's own signal belongs to the caller. */
	cancel: () => void;
	/** The compaction-prewarm rule of the session it was requested for: told when it was billed for nothing. */
	watch: PrewarmWatch;
}

/** Notes, in the session the summary was requested for, that an early summary was not used and why. */
type DiscardNote = (reason: string) => void;

function discarded(entry: EarlySummary, reason: string, note: DiscardNote | undefined): void {
	entry.watch.wasted("discarded");
	note?.(
		entry.settled
			? `the early summary was discarded after its request finished (billed, not used): ${reason}`
			: `the early summary was discarded while its request was running: ${reason}`,
	);
}

/** Why a compaction does not take the early summary, for its discard note. */
function skipReason(
	paidAlready: boolean,
	downshift: boolean,
	event: { reason: string; customInstructions?: string; requestedBy?: string },
): string {
	if (paidAlready) return "a summary of the same input was already paid for";
	if (downshift) return "the compaction summarizes on the model before a downshift";
	if (event.reason === "manual" && event.requestedBy !== "agent")
		return event.customInstructions ? "the user's compaction has its own focus" : "the user asked for this compaction";
	if (event.customInstructions) return "the compaction has its own instructions";
	return `the compaction is ${event.reason}, not at the threshold`;
}

/**
 * Drops this session's early summary when the compaction will not take it (a manual or focused compaction, a
 * downshift, a summary already paid for), noting why. Does nothing when there is none.
 */
export function discardEarlySummary(sessionManager: object, reason: string, note: DiscardNote): void {
	const entry = early.get(sessionManager);
	if (!entry) return;
	early.delete(sessionManager);
	discarded(entry, reason, note);
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
	ctx: Pick<FeatureContext, "cwd" | "model" | "modelRegistry" | "sessionManager">,
	cold: boolean,
): void {
	const model = ctx.model;
	if (!model || cold || event.signal.aborted) return;
	const { preparation, signal } = event;
	const recordUsage = api.usage.createRecorder("compaction_attempt");
	const watch = prewarmWatchOf(api);
	const requestedAt = Date.now();
	// The request runs under its own signal, so a newer request for the session can stop it without touching the caller's.
	const own = new AbortController();
	const forward = () => own.abort();
	signal.addEventListener("abort", forward, { once: true });
	const note = (text: string) => {
		if (!signal.aborted) recordCompactionNote(api, "early-summary", text);
	};
	note(
		`requested the compaction summary ahead of the threshold, beside the run (about ${preparation.tokensBefore.toLocaleString("en-US")} tokens in context)`,
	);
	let unusable: string | undefined;
	const written = sharedSummary(
		api,
		{ ...event, signal: own.signal },
		ctx,
		model,
		// No focus: the plan's compaction may be the threshold's or the agent's, whose focus follows the summary.
		"",
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
			if (!result) {
				note(`the early summary cannot be used (${unusable ?? "cancelled"}); the compaction requests its own`);
				// A request this session stopped (a dropped plan, a newer prewarm) is reported where it was stopped.
				if (!own.signal.aborted) watch.wasted("failed");
			}
			if (!result || signal.aborted) return undefined;
			note(`the early summary is ready after ${seconds} s; the compaction uses it without waiting`);
			return { result, lists: fileLists(preparation).text };
		})
		.catch(() => {
			if (!own.signal.aborted) watch.wasted("failed");
			return undefined;
		});
	const plan = planOf(model, preparation, api.models.getThinkingLevel(), event.summaryRequest?.forceSystemPrompt);
	const entry: EarlySummary = { plan, signal, requestedAt, written, settled: false, cancel: () => own.abort(), watch };
	void written.finally(() => {
		entry.settled = true;
		signal.removeEventListener("abort", forward);
	});
	// A second prewarm replaces the first: its request is stopped instead of running on, billed, with nobody to take it.
	const replaced = early.get(ctx.sessionManager);
	if (replaced) {
		replaced.cancel();
		replaced.watch.wasted("replaced");
		note(
			replaced.settled
				? "the early summary was replaced by a newer plan's after its request finished (billed, not used)"
				: "the early summary was replaced by a newer plan's while its request was running",
		);
	}
	early.set(ctx.sessionManager, entry);
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
	note?: DiscardNote,
): Promise<{ result: CompactionResult; early: { requestedAt: string; waitedMs: number } } | undefined> {
	const entry = early.get(sessionManager);
	if (!entry) return undefined;
	early.delete(sessionManager);
	if (signal.aborted) return undefined;
	if (entry.signal.aborted) {
		discarded(entry, "its plan was dropped (the branch, model or settings changed)", note);
		return undefined;
	}
	if (entry.plan !== planOf(model, preparation, thinking, forcedSystemPrompt)) {
		discarded(entry, "it was written for another plan (cut point, messages, model or instructions differ)", note);
		return undefined;
	}
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
	if (!written || signal.aborted) return undefined;
	if (entry.signal.aborted || !written.result.summary.endsWith(written.lists)) {
		discarded(
			entry,
			entry.signal.aborted ? "its plan was dropped while the compaction waited" : "its file lists did not match",
			note,
		);
		return undefined;
	}
	entry.watch.waited(waitedMs);
	const text = written.result.summary.slice(0, written.result.summary.length - written.lists.length);
	const now = fileLists(preparation);
	return {
		result: {
			...written.result,
			summary: `${text}${now.text}`,
			tokensBefore: preparation.tokensBefore,
			details: { ...asRecord(written.result.details), ...now.lists },
		},
		early: { requestedAt: new Date(entry.requestedAt).toISOString(), waitedMs },
	};
}

/**
 * The early summary a compaction can take: the threshold's without a focus of its own, or the agent's own request
 * (`compact`), never one written on another model or one already paid for. Otherwise the early summary is discarded,
 * with a note saying why. A taken summary names the usage entries that paid for it before this compaction started.
 */
export async function earlySummaryFor(
	api: SetupPick<"models", "getThinkingLevel"> & SetupPick<"session", "appendEntry">,
	event: Pick<
		SessionBeforeCompactEvent,
		"reason" | "requestedBy" | "customInstructions" | "preparation" | "signal" | "branchEntries"
	>,
	ctx: Pick<FeatureContext, "sessionManager">,
	model: Model<Api>,
	options: { paidAlready: boolean; downshift: boolean; forced?: string },
): Promise<{ result: CompactionResult; early: { requestedAt: string; waitedMs: number } } | undefined> {
	const note = (text: string) => recordCompactionNote(api, "early-summary", text);
	const agent = event.reason === "manual" && event.requestedBy === "agent";
	const eligible =
		!options.paidAlready && !options.downshift && (event.reason === "threshold" ? !event.customInstructions : agent);
	if (!eligible) {
		discardEarlySummary(ctx.sessionManager, skipReason(options.paidAlready, options.downshift, event), note);
		return undefined;
	}
	const thinking = api.models.getThinkingLevel();
	const taken = await takeEarlySummary(
		ctx.sessionManager,
		model,
		event.preparation,
		thinking,
		event.signal,
		options.forced,
		note,
	);
	if (!taken) return undefined;
	const attemptIds = compactionAttemptIds(event.branchEntries, taken.early.requestedAt);
	return {
		...taken,
		result: { ...taken.result, details: { ...asRecord(taken.result.details), [ATTEMPT_IDS_DETAILS]: attemptIds } },
	};
}
