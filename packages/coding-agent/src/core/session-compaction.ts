/**
 * The compaction core both entry points share: manual `AgentSession.compact()` and automatic threshold or overflow
 * compaction. Each caller prepares the compaction, owns its abort controller, events and failure accounting, and calls
 * `runCompaction()` for the part in between.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { Model, Usage } from "@octocodeai/octocode-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	estimateTokens,
	finalizeCompactionResult,
	fitCompactionToWindow,
	projectionAfterCompaction,
	type SummaryRequestPolicy,
} from "./compaction/index.ts";
import type { CompactionRequester } from "./compaction/manual-options.ts";
import { compactionAttemptIds, withOutcome } from "./compaction/outcome.ts";
import type { SummaryFocus } from "./compaction/summary-focus.ts";
import type { FeatureHost } from "./features/index.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** What the compaction core needs of the session. */
export interface CompactionHost {
	readonly sessionManager: SessionManager;
	readonly featureHost: FeatureHost;
	/** The default summary, when no feature supplies one. */
	summarize(
		preparation: CompactionPreparation,
		model: Model<any>,
		signal: AbortSignal,
		reason: CompactionReason,
		customInstructions?: string | SummaryFocus,
		request?: SummaryRequestPolicy,
	): Promise<CompactionResult>;
	/** How this compaction's summary requests are watched and retried; made once per run. */
	summaryRequest?(reason: CompactionReason): SummaryRequestPolicy;
	/** Rebuild the agent's context from the session after the compaction is saved. */
	refreshContext(): void;
}

export interface CompactionRun {
	customInstructions?: string;
	/** Who asked for a manual compaction (default the user); its focus is labelled as theirs. */
	requestedBy?: CompactionRequester;
	reason: CompactionReason;
	willRetry: boolean;
	model: Model<any>;
	/** Context window and reserve the summary is finalized for. */
	contextWindow: number;
	reserveTokens: number;
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	/** Estimated tokens of a prompt that waits for this compaction, not yet on the branch: the kept tail makes room for it. */
	incomingTokens?: number;
	signal: AbortSignal;
	/** Throws when the run must stop, checked after the feature hook and after the summary. */
	checkAbort(stage: "hook" | "summary"): void;
	/** Filled as the run goes, so a caller's failure handling can tell what happened. */
	outcome: { fromFeature: boolean; cancelledByFeature: boolean };
}

/**
 * The tokens `messages` take on `model`, at its tokenizer family's ratio (`charsPerToken`), so a GPT model's context is
 * not read as Claude's denser count.
 */
function estimateMessagesTokens(messages: readonly AgentMessage[], model: Pick<Model<any>, "id" | "provider">): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message, model);
	}
	return tokens;
}

/**
 * Fit the kept tail to the target window, ask `session_before_compact` features, summarize (theirs or the default),
 * save the compaction entry with its outcome (`compaction/outcome.ts`), refresh the context and announce
 * `session_compact`. Throws "Compaction cancelled" when an feature cancels, and `CompactionFitError` before any request
 * when nothing kept can fit the window.
 */
export async function runCompaction(host: CompactionHost, run: CompactionRun): Promise<CompactionResult> {
	const { reason, willRetry, signal } = run;
	// Sized for the target window before any request: a summary that could never be saved is not paid for, and a prompt
	// that waits for it must fit beside what it keeps.
	const preparation = fitCompactionToWindow(run.branchEntries, run.preparation, run.contextWindow, {
		incomingTokens: run.incomingTokens,
		model: run.model,
		summarizeFailedTurn: !willRetry,
	});
	const startedAt = new Date().toISOString();
	const requestedBy = reason === "manual" ? (run.requestedBy ?? "user") : undefined;
	const focus: SummaryFocus | undefined = run.customInstructions
		? { text: run.customInstructions, source: requestedBy ?? "user" }
		: undefined;
	let featureCompaction: CompactionResult | undefined;
	const summaryRequest = host.summaryRequest?.(reason);

	if (host.featureHost.hasHandlers("session_before_compact")) {
		const result = await host.featureHost.emit({
			type: "session_before_compact",
			preparation,
			customInstructions: run.customInstructions,
			...(requestedBy ? { requestedBy } : {}),
			branchEntries: run.branchEntries,
			reason,
			willRetry,
			signal,
			...(summaryRequest ? { summaryRequest } : {}),
		});

		if (result?.cancel) {
			// A failure reported through the hook is not a cancel: it counts toward the automatic failure limit.
			if ("failure" in result && result.failure) throw new Error(result.failure);
			run.outcome.cancelledByFeature = true;
			throw new Error("Compaction cancelled");
		}

		if (result?.compaction) {
			featureCompaction = result.compaction;
			run.outcome.fromFeature = true;
		}
	}
	run.checkAbort("hook");

	// Feature-provided content, or the shared default summary generator.
	const produced =
		featureCompaction ?? (await host.summarize(preparation, run.model, signal, reason, focus, summaryRequest));
	const { firstKeptEntryId, tokensBefore } = produced;
	const usage: Usage | undefined = produced.usage;
	run.checkAbort("summary");
	if (!produced.summary.trim()) throw new Error("Compaction failed: the summary was empty");

	const finalized = finalizeCompactionResult(
		{
			summary: produced.summary,
			firstKeptEntryId,
			tokensBefore,
			details: produced.details,
			...(usage ? { usage } : {}),
		},
		{
			branchEntries: host.sessionManager.getBranch(),
			contextWindow: run.contextWindow,
			reserveTokens: run.reserveTokens,
			sessionFile: host.sessionManager.getSessionFile(),
		},
	);
	const { summary } = finalized;
	const branch = host.sessionManager.getBranch();
	// Estimated before the entry is saved, from the context the entry will leave, so the entry can record it: for the
	// model the next request goes to.
	const estimatedTokensAfter = estimateMessagesTokens(
		projectionAfterCompaction(branch, firstKeptEntryId, tokensBefore)(summary).projection.messages,
		run.model,
	);
	// The entry's own timestamp is its save time; `startedAt` makes the run's wall time measurable.
	const timed =
		finalized.details === undefined || isRecord(finalized.details)
			? { ...finalized.details, startedAt }
			: finalized.details;
	const details = withOutcome(timed, {
		trigger: reason === "manual" ? (requestedBy ?? "user") : reason,
		focus,
		estimatedTokensAfter,
		attemptIds: compactionAttemptIds(branch, startedAt),
	});

	const compactionId = host.sessionManager.appendCompaction(
		summary,
		firstKeptEntryId,
		tokensBefore,
		details,
		run.outcome.fromFeature,
		usage,
	);
	host.refreshContext();

	const savedCompactionEntry = host.sessionManager.getEntry(compactionId);
	if (host.featureHost && savedCompactionEntry?.type === "compaction") {
		await host.featureHost.emit({
			type: "session_compact",
			compactionEntry: savedCompactionEntry,
			fromFeature: run.outcome.fromFeature,
			reason,
			willRetry,
		});
	}

	return { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details };
}
