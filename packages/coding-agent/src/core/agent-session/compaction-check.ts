/** The decision whether a finished response triggers automatic compaction, and which kind. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	isContextOverflow,
	isRecoverableLength,
	type Model,
} from "@octocodeai/octocode-ai/compat";
import {
	calculateContextTokens,
	estimateContextTokens,
	estimateProjectedContextTokens,
	shouldCompact,
} from "../compaction/index.ts";
import type { SessionCompactFailedEvent } from "../extensions/index.ts";
import { type ContextEditEntry, getLatestCompactionEntry } from "../session-manager.ts";
import type { SessionInternals } from "./host.ts";

export interface CompactionCheckHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	findPersistedMessageEntryId(message: AgentMessage): string | undefined;
	omitRecoveryAttempt(message: AssistantMessage, toolResults?: AgentMessage[]): void;
	/** The session's `_runAutoCompaction`. */
	runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean, targetModel?: Model<any>): Promise<boolean>;
	emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void>;
}

/**
 * Dispatch automatic compaction after `agent_end` or before prompt submission.
 * Manual compaction does not call this method; it enters through `compact()`.
 *
 * Automatic cases:
 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
 *    remove the failed assistant message, compact, and retry the turn once.
 * 2. Overflow without retry: a successful response exceeded the configured
 *    context window; compact but preserve the completed response.
 * 3. Threshold without retry: valid or estimated context usage crossed the
 *    configured threshold; compact without retrying the completed response.
 *
 * Each case calls `_runAutoCompaction()`. After preparation and the
 * `session_before_compact` hook, that method calls the lower-level `compact()`
 * function imported from `./compaction/index.ts`, unless the hook cancels or
 * supplies a custom result.
 *
 * @param assistantMessage The assistant message to check
 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
 */
export async function checkCompaction(
	host: CompactionCheckHost,
	assistantMessage: AssistantMessage,
	skipAbortedCheck: boolean,
	toolResults: AgentMessage[],
): Promise<boolean> {
	const { session, run } = host;
	const messageModel = host.modelForMessage(assistantMessage);
	const settings = session.settingsManager.getCompactionSettings(messageModel ?? session.model);
	if (!settings.enabled) return false;

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

	// Skip overflow check if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model. Under a virtual selection, the
	// physical model that produced the message supplies the limits.
	const sameModel = messageModel !== undefined;
	const contextWindow = (messageModel ?? session.model)?.contextWindow ?? 0;

	// Skip compaction checks if this assistant message is older than the latest
	// compaction boundary. This prevents a stale pre-compaction usage/error
	// from retriggering compaction on the first prompt after compaction.
	const compactionEntry = getLatestCompactionEntry(session.sessionManager.getBranch());
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) {
		return false;
	}

	// Automatic cases 1 and 2: context overflow.
	// A length stop is recoverable when output ended below the model's original desired limit,
	// independent of the configured context size or any context-clamped provider request limit.
	const currentProjection = session.sessionManager.buildSessionProjection();
	const assistantEntryId = host.findPersistedMessageEntryId(assistantMessage);
	const assistantIsProjected =
		assistantEntryId === undefined ||
		currentProjection.entries.some(
			(entry) =>
				entry.sourceEntry.id === assistantEntryId && entry.messages.some((message) => message.role === "assistant"),
		);
	const branch = session.sessionManager.getBranch();
	const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
	const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
	const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
	const latestAssistantEdit = entriesAfterAssistant
		.filter((entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId)
		.at(-1);
	const assistantRetainedForExplicitRecovery =
		assistantEntryId === undefined ||
		(!entriesAfterAssistant.some((entry) => entry.type === "compaction") && latestAssistantEdit?.replacement !== null);
	const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
	const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
	const contextOverflow =
		sameModel &&
		((explicitOverflow && assistantRetainedForExplicitRecovery) ||
			(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
	const recoverableLength =
		sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
	if (contextOverflow || recoverableLength) {
		const willRetry = assistantMessage.stopReason !== "stop";

		// Case 2: the response completed successfully. Compact, but do not retry because
		// agent.continue() cannot continue from a completed assistant response.
		if (!willRetry) {
			return await host.runAutoCompaction("overflow", false, messageModel);
		}

		if (run.overflowRecoveryAttempted) {
			const errorMessage = contextOverflow
				? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
				: "Truncated response recovery failed after one compact-and-retry attempt.";
			host.emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage,
			});
			await host.emitSessionCompactFailed({
				reason: "overflow",
				errorMessage,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			return false;
		}

		// Persistently omit the selected final attempt before post-run recovery compaction.
		run.overflowRecoveryAttempted = true;
		host.omitRecoveryAttempt(assistantMessage, toolResults);
		const retry = await host.runAutoCompaction("overflow", willRetry, messageModel);
		if (retry) run.failedResponse = assistantMessage;
		return retry;
	}

	// Case 3: threshold compaction without retry.
	// For error messages or all-zero usage messages, estimate from the last valid response.
	// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
	// responses can still compact and do not reset context accounting.
	let contextTokens: number;
	const projection = currentProjection;
	const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
	const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
	if (hasContextEdits) {
		contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
	} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
		const messages = session.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		// Without provider usage, estimate.tokens is the pure message-size estimate.
		// Only usage-backed estimates need the stale pre-compaction check.
		if (estimate.lastUsageIndex !== null) {
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
		}
		contextTokens = estimate.tokens;
	} else {
		contextTokens = directContextTokens;
	}
	if (shouldCompact(contextTokens, contextWindow, settings)) {
		return await host.runAutoCompaction("threshold", false, messageModel);
	}
	return false;
}
