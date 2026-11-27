/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@octocodeai/octocode-ai";
import type { Model, Usage } from "@octocodeai/octocode-ai/compat";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { type CompactionEntry, type ProjectedSessionEntry, type SessionEntry } from "../session-manager.ts";
import { buildPathProjection } from "../session-manager/context.ts";
import { renderPrompt } from "../prompt-template.ts";
import { combineUsage } from "../usage-totals.ts";
import { archivedSummary } from "./checkpoint.ts";
import { findProjectedCutPoint } from "./cut-point.ts";
import { generateTurnPrefixSummary } from "./bounded-summary.ts";
import { ledgerDetails, type LiftedBullet } from "./ledger.ts";
import { compactionThresholdTokens, inputRoomTokens, replyFloorTokens } from "./settings.ts";
import { generateSummaryWithUsage } from "./summarization.ts";
import type { SummaryFocus } from "./summary-focus.ts";
import { withTurnContext } from "./summary-format.ts";
import { estimateProjectedContextTokens } from "./tokens.ts";
import type { CompactionResult } from "./types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
} from "./utils.ts";

// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	// System messages are prompt state, not conversation; the compaction entry carries their replay.
	return entry.messages.filter((message) => message.role !== "system");
}

/** The messages of `entries` as `getMessagesFromProjectedEntryForCompaction` yields them, each with its session entry's id. */
function messagesWithEntryIds(entries: ProjectedSessionEntry[]): { messages: AgentMessage[]; entryIds: string[] } {
	const picked = entries.flatMap((entry) =>
		getMessagesFromProjectedEntryForCompaction(entry).map((message) => ({ message, id: entry.sourceEntry.id })),
	);
	return { messages: picked.map((item) => item.message), entryIds: picked.map((item) => item.id) };
}

// Types
// ============================================================================

export interface CompactionSettings {
	maxInputTokens?: number;
	/** `limits.compaction.trigger` in tokens: compaction starts here when it is below the reserve's own point. */
	triggerTokens?: number;
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

// Token calculation
// ============================================================================

/**
 * Check if compaction should trigger based on context usage. A window of 0 or less is unknown, so there is no threshold.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || !(contextWindow > 0)) return false;
	return contextTokens > compactionThresholdTokens(contextWindow, settings);
}

/**
 * Whether a request of `contextTokens` would not fit `contextWindow` at all: it leaves less than the reply's floor
 * (`replyFloorTokens`, with the model's `maxOutputTokens`) free. This is the hard limit, past the threshold. A window of 0
 * or less is unknown, so nothing exceeds it.
 */
export function exceedsContextWindow(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	maxOutputTokens?: number,
): boolean {
	if (!settings.enabled || !(contextWindow > 0)) return false;
	return (
		contextTokens >
		inputRoomTokens(contextWindow, replyFloorTokens(settings.reserveTokens, maxOutputTokens), settings.maxInputTokens)
	);
}

// Compaction Preparation (for features)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** The persisted session entry id of each of `messagesToSummarize`, index for index. */
	messageEntryIds?: string[];
	/** The persisted session entry id of each of `turnPrefixMessages`, index for index. */
	turnPrefixEntryIds?: string[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export interface PrepareOptions {
	/** Summarize every message and keep only the branch's last entry (a turn that already failed, kept whole by nothing). */
	summarizeAll?: boolean;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: PrepareOptions = {},
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	// The branch as `getBranch` returns it: projected without indexing it, as `checkpoint.ts` does.
	const projection = buildPathProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first. Older compaction entries can still
	// occur in its retained raw range, but their projected contribution is empty.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const previous = projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry;
		// A checkpoint too long to stay inline was replaced by a reference to its saved text; the update builds on that text.
		previousSummary = archivedSummary(previous.details) ?? previous.summary;
		// The canonical projection has already selected the previous compaction's retained tail.
		boundaryStart = prevCompactionIndex + 1;
	}
	const boundaryEnd = projectedEntries.length;
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	const cutPoint = options.summarizeAll
		? { firstKeptEntryIndex: boundaryEnd - 1, turnStartIndex: -1, isSplitTurn: false }
		: findProjectedCutPoint(projectedEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const { messages: messagesToSummarize, entryIds: messageEntryIds } = messagesWithEntryIds(
		projectedEntries.slice(boundaryStart, historyEnd),
	);
	const { messages: turnPrefixMessages, entryIds: turnPrefixEntryIds } = messagesWithEntryIds(
		cutPoint.isSplitTurn ? projectedEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex) : [],
	);

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	// Extract file operations from edited model-visible messages and the previous compaction.
	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		messageEntryIds,
		turnPrefixEntryIds,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// Main compaction function
// ============================================================================

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional focus for the summary, labelled by who wrote it (a string is the user's); a split
 * turn sends it with the history request, or with the turn-prefix request when there is no history to summarize, never
 * with both
 * @param sessionId - Optional routing session ID; with `cache`, the session's cache preferences, so the summary request
 * is routed and cached as the session's own are (without them: a fresh id and no cache writes)
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string | SummaryFocus,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	cache?: CachePreferences,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage;
	// The carried bullets the model lifted (`ledger.ts`), recorded with the compaction.
	let lifted: LiftedBullet[] = [];
	// Messages the summary request left out because they did not fit: the reader of the summary is told how many.
	let dropped = 0;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				preparation.settings?.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
				cache,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
			lifted = historyResult.lifted;
			dropped = historyResult.dropped;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
			messagesToSummarize.length > 0 ? undefined : customInstructions,
			cache,
		);
		// One checkpoint: the turn's prefix is a section of it, ahead of its closing TL;DR.
		summary = withTurnContext(historyText, turnPrefixResult.text);
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			preparation.settings?.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
			cache,
		);
		summary = result.text;
		summaryUsage = result.usage;
		lifted = result.lifted;
		dropped = result.dropped;
	}
	if (dropped > 0) summary += `\n\n${renderPrompt("workflows/compaction/dropped-summary-note.md", { dropped })}`;

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no id");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles, ...ledgerDetails(summary, lifted) },
	};
}
