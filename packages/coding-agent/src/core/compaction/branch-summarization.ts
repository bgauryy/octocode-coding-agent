/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import { renderInstruction } from "../prompt-template.ts";
import type { AgentMessage, StreamFn } from "@octocodeai/octocode-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@octocodeai/octocode-ai";
import { contentText, normalizeContext } from "@octocodeai/octocode-ai";
import type { Model, SimpleStreamOptions, Usage } from "@octocodeai/octocode-ai/compat";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type { ContextEditEntry, ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { projectContextEntry } from "../session-manager/context.ts";
import { ancestors } from "../session-manager/ancestors.ts";
import { summaryMaxTokens } from "./settings.ts";
import { completeSummarization, getSummarizationFailure } from "./summarization.ts";
import { DEFAULT_RESERVE_TOKENS } from "../settings-defaults.ts";
import { SUMMARY_CHECKPOINT_FORMAT } from "./summary-format.ts";
import { estimateTokens } from "./tokens.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeMessages,
} from "./utils.ts";

// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	apiKey?: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	env?: Record<string, string>;
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved when selecting branch history (default `DEFAULT_RESERVE_TOKENS`) */
	reserveTokens?: number;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	streamFn?: StreamFn;
	/** Retry policy for transient summarization errors. Reuses coding-agent's `settings.retry`. */
	retry?: RetryPolicy;
	/** Optional callbacks for retry reporting (e.g. TUI retry indicators). */
	callbacks?: RetryCallbacks;
}

// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	for (const entry of ancestors(session.getEntry(oldLeafId), (id) => session.getEntry(id))) {
		if (entry.id === commonAncestorId) break;
		entries.push(entry);
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// Entry to Message Conversion
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry: SessionEntry, edit?: ContextEditEntry): AgentMessage | undefined {
	const message = getRawMessageFromEntry(entry);
	// Apply the same context edit projection the live context uses, so removed or replaced content is not summarized.
	return message && edit ? projectContextEntry(entry, edit)[0] : message;
}

function getRawMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// Skip tool results - context is in assistant's tool call
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
		case "usage":
		case "context_edit":
			return undefined;
	}
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	const edits = new Map<string, ContextEditEntry>();
	for (const entry of entries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry, edits.get(entry.id));
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PROMPT = renderInstruction("workflows/compaction/branch-summary.md", {
	format: SUMMARY_CHECKPOINT_FORMAT,
});

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = DEFAULT_RESERVE_TOKENS,
		streamFn,
		retry,
		callbacks,
	} = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Serialize to text so the model does not treat it as a conversation to continue; custom messages keep their type as the label.
	const conversationText = serializeMessages(messages);

	// Build prompt
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization. Prefer the session stream function so SDK
	// request behavior (timeouts, retries, attribution headers) stays consistent
	// without running through agent state/events. Retried via completeSummarization
	// so transient stream drops reuse the configured retry policy.
	const context = normalizeContext({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages });
	// The same output cap as a compaction summary; a branch summary sends no thinking.
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: summaryMaxTokens(model) };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// Check if aborted or errored
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Branch summarization attempted to call a tool" };
	}

	let summary = contentText(response.content);

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
