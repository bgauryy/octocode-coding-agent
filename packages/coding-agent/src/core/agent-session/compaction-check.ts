/** The decision whether a finished response triggers automatic compaction, and which kind. */

import type { AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	isContextOverflow,
	isRecoverableLength,
	type Model,
} from "@octocodeai/octocode-ai/compat";
import { calculateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import {
	estimateContextTokens,
	estimateLeafContextTokens,
	estimateTokens,
	exceedsContextWindow,
	shouldCompact,
} from "../compaction/index.ts";
import type { SessionCompactFailedEvent } from "../features/index.ts";
import type {
	ContextEditEntry,
	ReadonlySessionManager,
	ReadonlySessionProjection,
	SessionEntry,
} from "../session-manager.ts";
import { ancestors } from "../session-manager/ancestors.ts";
import type { SessionInternals, SessionRunState } from "./host.ts";

/** How many times the provider's count the local estimate must be to override it. */
const LOCAL_ESTIMATE_OVERRIDE = 2;

export interface CompactionCheckHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	findPersistedMessageEntryId(message: AgentMessage): string | undefined;
	omitRecoveryAttempt(message: AssistantMessage): void;
	/** The session's `_runAutoCompaction`; `incomingTokens` is a prompt that waits for the compaction. */
	runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		targetModel?: Model<any>,
		targetThinking?: ThinkingLevel,
		incomingTokens?: number,
	): Promise<boolean>;
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
 * @param incoming Messages about to be appended (the pre-prompt path passes the incoming prompt); counted toward the threshold
 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
 */
export async function checkCompaction(
	host: CompactionCheckHost,
	assistantMessage: AssistantMessage,
	skipAbortedCheck: boolean,
	incoming: readonly AgentMessage[] = [],
): Promise<boolean> {
	const { session, run } = host;
	const messageModel = host.modelForMessage(assistantMessage);
	const settings = session.settingsManager.getCompactionSettings(
		messageModel ?? session.model,
		session.routedModel?.thinkingLevel ?? session.thinkingLevel,
	);
	if (!settings.enabled) return false;

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

	// Skip overflow check if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model. Under a virtual selection, the
	// physical model that produced the message supplies the limits.
	const sameModel = messageModel !== undefined;
	const limitsModel = messageModel ?? session.model;
	const contextWindow = limitsModel?.contextWindow ?? 0;
	// New content is estimated at the model's tokenizer ratio, as every threshold check counts it.
	let incomingTokens = 0;
	for (const message of incoming) incomingTokens += estimateTokens(message, limitsModel);
	// A threshold compaction before a prompt makes room for it; the user's cancel holds for the request it was for.
	const compactForThreshold = () => {
		if (compactionCancelledForRequest(run, session.sessionManager)) return Promise.resolve(false);
		return incomingTokens > 0
			? host.runAutoCompaction("threshold", false, messageModel, undefined, incomingTokens)
			: host.runAutoCompaction("threshold", false, messageModel);
	};

	// Skip compaction checks if this assistant message is older than the latest
	// compaction boundary. This prevents a stale pre-compaction usage/error
	// from retriggering compaction on the first prompt after compaction.
	// The branch is read from the leaf back, only as far as needed: its latest compaction leads the projection, which
	// otherwise holds none; without a leaf entry the branch is empty.
	const sessionManager = session.sessionManager;
	// Read without copying: every use below comes before anything appends to the session.
	const currentProjection = sessionManager.readSessionProjection();
	const leaf = sessionManager.getLeafEntry();
	const head = currentProjection.entries[0]?.sourceEntry;
	const compactionEntry = leaf && head?.type === "compaction" ? head : null;
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) {
		// The old response's usage and errors are stale, but input added since the checkpoint is not. That compaction is
		// the coming request's one: another runs only when the request would not fit the window at all.
		if (!skipAbortedCheck) {
			const tokens = estimateLeafContextTokens(currentProjection, sessionManager, limitsModel).tokens + incomingTokens;
			if (exceedsContextWindow(tokens, contextWindow, settings, limitsModel?.maxTokens)) return compactForThreshold();
		}
		return false;
	}

	// Automatic cases 1 and 2: context overflow.
	// A length stop is recoverable when output ended below the model's original desired limit,
	// independent of the configured context size or any context-clamped provider request limit.
	const assistantEntryId = host.findPersistedMessageEntryId(assistantMessage);
	const assistantIsProjected =
		assistantEntryId === undefined ||
		currentProjection.entries.some(
			(entry) =>
				entry.sourceEntry.id === assistantEntryId && entry.messages.some((message) => message.role === "assistant"),
		);
	const entriesAfterAssistant = assistantEntryId ? branchAfter(sessionManager, leaf, assistantEntryId) : [];
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
	// A length stop below the model's desired output limit is overflow only when the context left too little room for
	// the reply; elsewhere it is a plain truncation, so the reply stays and nothing is compacted.
	const recoverableLength =
		sameModel &&
		assistantIsProjected &&
		isRecoverableLength(assistantMessage, messageModel.maxTokens) &&
		lengthStopNearWindow(assistantMessage, currentProjection, sessionManager, messageModel, settings);
	if (contextOverflow || recoverableLength) {
		const willRetry = assistantMessage.stopReason !== "stop";

		// Case 2: the response completed successfully. Compact, but do not retry because
		// agent.continue() cannot continue from a completed assistant response.
		if (!willRetry) {
			return host.runAutoCompaction("overflow", false, messageModel);
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
				fromFeature: false,
			});
			return false;
		}

		// Persistently omit the selected final attempt before post-run recovery compaction.
		run.overflowRecoveryAttempted = true;
		if (!contextOverflow) run.lengthRecoveries++;
		host.omitRecoveryAttempt(assistantMessage);
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
		contextTokens = estimateLeafContextTokens(projection, sessionManager, limitsModel).tokens;
	} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
		const messages = session.agent.state.messages;
		const estimate = estimateContextTokens(messages, limitsModel);
		// Without provider usage, estimate.tokens is the pure message-size estimate.
		// Only usage-backed estimates need the stale pre-compaction check.
		if (estimate.lastUsageIndex !== null) {
			// Kept pre-compaction messages carry stale usage for the old, larger context. Size the
			// projected context from message content instead of trusting it or skipping the check.
			const usageMsg = messages[estimate.lastUsageIndex];
			const usageIsStale =
				compactionEntry &&
				usageMsg.role === "assistant" &&
				usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime();
			contextTokens = usageIsStale
				? estimateLeafContextTokens(projection, sessionManager, limitsModel).tokens
				: estimate.tokens;
		} else {
			contextTokens = estimate.tokens;
		}
	} else {
		// The provider counted the context up to this response. Before a prompt, idle bash output, custom or
		// steering messages and restored files appended after it are not in that count, so add their estimate.
		// After a run, the messages that follow are its own tool results; a terminating tool's large result must
		// not compact straight after the run, and the next prompt's check counts it.
		contextTokens = directContextTokens;
		if (!skipAbortedCheck)
			contextTokens += estimateTrailingTokens(session.agent.state.messages, assistantMessage, limitsModel);
		// A provider count can be stale or missing part of the context (cache accounting, a gateway). The stored messages up
		// to the response are a ratio estimate, so they override it only when they are more than twice the count.
		const stored = session.agent.state.messages;
		const upTo = stored.lastIndexOf(assistantMessage);
		const local = estimateMessagesTokens(upTo < 0 ? stored : stored.slice(0, upTo + 1), limitsModel);
		if (local > directContextTokens * LOCAL_ESTIMATE_OVERRIDE) contextTokens = Math.max(contextTokens, local);
	}
	contextTokens += incomingTokens;
	return shouldCompact(contextTokens, contextWindow, settings) ? compactForThreshold() : false;
}

/**
 * Whether the branch compacted since its latest response, so the request about to be sent already had its compaction
 * (before the prompt, after the last run, or between turns). One compaction per request: another runs only when the
 * request would not fit the window at all (`exceedsContextWindow`), not at the threshold.
 */
export function compactedSinceLastResponse(
	projection: ReadonlySessionProjection,
	sessionManager: Pick<ReadonlySessionManager, "getLeafEntry" | "getEntry">,
): boolean {
	// The branch's latest compaction leads the projection; the walk back from the leaf stops at it.
	const head = projection.entries[0]?.sourceEntry;
	if (head?.type !== "compaction") return false;
	for (const entry of ancestors(sessionManager.getLeafEntry(), (id) => sessionManager.getEntry(id))) {
		if (entry.id === head.id) return true;
		if (entry.type === "message" && entry.message.role === "assistant") return false;
	}
	return false;
}

/**
 * Records that the user cancelled an automatic compaction while the run goes on: none runs again for the request it was
 * for. A cancel that ends the run does not hold: the next prompt is a new request.
 */
export function markCompactionCancelled(
	run: SessionRunState,
	sessionManager: Pick<ReadonlySessionManager, "getLeafEntry">,
): void {
	if (!run.agentRunAbortRequested) run.compactionCancelledAt = sessionManager.getLeafEntry()?.id;
}

/**
 * Whether the user cancelled an automatic compaction for the request about to be sent: no reply follows the branch's
 * leaf at the cancel. A reply, or a branch that no longer holds that entry, ends the hold.
 */
export function compactionCancelledForRequest(
	run: SessionRunState,
	sessionManager: Pick<ReadonlySessionManager, "getLeafEntry" | "getEntry">,
): boolean {
	const at = run.compactionCancelledAt;
	if (at === undefined) return false;
	for (const entry of ancestors(sessionManager.getLeafEntry(), (id) => sessionManager.getEntry(id))) {
		if (entry.id === at) return true;
		if (entry.type === "message" && entry.message.role === "assistant") break;
	}
	run.compactionCancelledAt = undefined;
	return false;
}

/** Local estimate of the whole stored conversation, ignoring provider usage. */
function estimateMessagesTokens(messages: readonly AgentMessage[], model: Model<any> | undefined): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateTokens(message, model);
	return tokens;
}

/** Estimated tokens of the messages after `assistantMessage`, whose provider usage does not include them. */
function estimateTrailingTokens(
	messages: readonly AgentMessage[],
	assistantMessage: AssistantMessage,
	model: Model<any> | undefined,
): number {
	const index = messages.lastIndexOf(assistantMessage);
	if (index < 0) return 0;
	let tokens = 0;
	for (let i = index + 1; i < messages.length; i++) tokens += estimateTokens(messages[i], model);
	return tokens;
}

/**
 * Whether the context at a length stop is close enough to `model`'s window to explain the cut-off as overflow: past the
 * threshold, or too close to the window for the model's desired output.
 */
export function lengthStopNearWindow(
	message: AssistantMessage,
	projection: ReadonlySessionProjection,
	sessionManager: Parameters<typeof estimateLeafContextTokens>[1],
	model: Model<any>,
	settings: Parameters<typeof shouldCompact>[2],
): boolean {
	const direct = calculateContextTokens(message.usage);
	const tokens = direct > 0 ? direct : estimateLeafContextTokens(projection, sessionManager, model).tokens;
	return shouldCompact(tokens, model.contextWindow, settings) || tokens + model.maxTokens > model.contextWindow;
}

/** The entries after `entryId` on the branch that ends at `leaf`, root first; empty when it is not on that branch. */
function branchAfter(
	sessionManager: Pick<ReadonlySessionManager, "getEntry">,
	leaf: SessionEntry | undefined,
	entryId: string,
): SessionEntry[] {
	const after: SessionEntry[] = [];
	for (const entry of ancestors(leaf, (id) => sessionManager.getEntry(id))) {
		if (entry.id === entryId) return after.reverse();
		after.push(entry);
	}
	return [];
}
