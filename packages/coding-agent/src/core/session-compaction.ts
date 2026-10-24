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
} from "./compaction/index.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** What the compaction core needs of the session. */
export interface CompactionHost {
	readonly sessionManager: SessionManager;
	readonly extensionRunner: ExtensionRunner;
	/** The default summary, when no extension supplies one. */
	summarize(
		preparation: CompactionPreparation,
		model: Model<any>,
		signal: AbortSignal,
		reason: CompactionReason,
		customInstructions?: string,
	): Promise<CompactionResult>;
	/** Rebuild the agent's context from the session after the compaction is saved. */
	refreshContext(): void;
}

export interface CompactionRun {
	customInstructions?: string;
	reason: CompactionReason;
	willRetry: boolean;
	model: Model<any>;
	/** Context window and reserve the summary is finalized for. */
	contextWindow: number;
	reserveTokens: number;
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	signal: AbortSignal;
	/** Throws when the run must stop, checked after the extension hook and after the summary. */
	checkAbort(stage: "hook" | "summary"): void;
	/** Filled as the run goes, so a caller's failure handling can tell what happened. */
	outcome: { fromExtension: boolean; cancelledByExtension: boolean };
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

/**
 * Ask `session_before_compact` extensions, summarize (theirs or the default), save the compaction entry, refresh the
 * context and announce `session_compact`. Throws "Compaction cancelled" when an extension cancels.
 */
export async function runCompaction(host: CompactionHost, run: CompactionRun): Promise<CompactionResult> {
	const { reason, willRetry, preparation, signal } = run;
	let extensionCompaction: CompactionResult | undefined;

	if (host.extensionRunner.hasHandlers("session_before_compact")) {
		const result = await host.extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			customInstructions: run.customInstructions,
			branchEntries: run.branchEntries,
			reason,
			willRetry,
			signal,
		});

		if (result?.cancel) {
			// A failure reported through the hook is not a cancel: it counts toward the automatic failure limit.
			if ("failure" in result && result.failure) throw new Error(result.failure);
			run.outcome.cancelledByExtension = true;
			throw new Error("Compaction cancelled");
		}

		if (result?.compaction) {
			extensionCompaction = result.compaction;
			run.outcome.fromExtension = true;
		}
	}
	run.checkAbort("hook");

	// Extension-provided content, or the shared default summary generator.
	const produced =
		extensionCompaction ?? (await host.summarize(preparation, run.model, signal, reason, run.customInstructions));
	const { firstKeptEntryId, tokensBefore } = produced;
	const usage: Usage | undefined = produced.usage;
	run.checkAbort("summary");

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
	const { summary, details } = finalized;

	const compactionId = host.sessionManager.appendCompaction(
		summary,
		firstKeptEntryId,
		tokensBefore,
		details,
		run.outcome.fromExtension,
		usage,
	);
	host.refreshContext();
	const estimatedTokensAfter = estimateMessagesTokens(host.sessionManager.buildSessionProjection().messages);

	// Get the saved compaction entry for the extension event
	const savedCompactionEntry = host.sessionManager.getEntry(compactionId);
	if (host.extensionRunner && savedCompactionEntry?.type === "compaction") {
		await host.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: savedCompactionEntry,
			fromExtension: run.outcome.fromExtension,
			reason,
			willRetry,
		});
	}

	return { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details };
}
