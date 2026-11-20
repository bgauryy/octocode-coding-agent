import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { type CacheMetrics, computeCacheMetrics } from "./cache-stats.ts";
import { calculateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { estimateLeafContextTokens } from "./compaction/index.ts";
import type { ContextUsage } from "./features/index.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";
import { ancestors } from "./session-manager/ancestors.ts";
import { addUsageToTotals, createUsageTotals, entryUsage } from "./usage-totals.ts";

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	/** Usage entries without the provider's final count, which makes `tokens` and `cost` lower bounds. */
	lowerBoundEntries: number;
	contextUsage?: ContextUsage;
	cache: CacheMetrics;
	/** Assistant responses whose thinking budget was reduced (or disabled) to fit the context. */
	thinkingReduced: number;
	compaction: {
		/** Truncated responses recovered by compacting and retrying since the session object was created. */
		lengthRecoveries: number;
	};
}

/** Message counts, token and cost totals, and cache metrics of the session file's entries. */
export function computeSessionStats(
	sessionManager: ReadonlySessionManager,
	session: Pick<SessionStats, "sessionFile" | "sessionId" | "contextUsage"> & { lengthRecoveries?: number },
): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	let thinkingReduced = 0;
	let lowerBoundEntries = 0;
	const usageTotals = createUsageTotals();

	for (const entry of sessionManager.getEntries()) {
		const spend = entryUsage(entry);
		if (spend) addUsageToTotals(usageTotals, spend.usage);
		if (spend?.usage.lowerBound) lowerBoundEntries++;
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			if (assistantMsg.thinkingBudget && assistantMsg.thinkingBudget.sent < assistantMsg.thinkingBudget.requested) {
				thinkingReduced++;
			}
		}
	}

	return {
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		cost: usageTotals.cost,
		lowerBoundEntries,
		cache: computeCacheMetrics(sessionManager.getEntries()),
		contextUsage: session.contextUsage,
		thinkingReduced,
		compaction: { lengthRecoveries: session.lengthRecoveries ?? 0 },
	};
}

/** How full `model`'s context window is with the current branch; unknown tokens right after a compaction. */
export function computeContextUsage(
	sessionManager: ReadonlySessionManager,
	model: Model<any> | undefined,
): ContextUsage | undefined {
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	// The branch is read from the leaf back, only as far as needed. Its latest compaction leads the projection, which
	// otherwise holds none; without a leaf entry the branch is empty.
	const projection = sessionManager.readSessionProjection();
	const leaf = sessionManager.getLeafEntry();
	const head = projection.entries[0]?.sourceEntry;
	const latestCompaction = leaf && head?.type === "compaction" ? head : undefined;

	if (latestCompaction) {
		const projectedAssistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason !== "aborted" &&
						message.stopReason !== "error" &&
						calculateContextTokens(message.usage) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		let hasPostCompactionUsage = false;
		for (const entry of ancestors(leaf, (id) => sessionManager.getEntry(id))) {
			if (entry.id === latestCompaction.id) break;
			if (projectedAssistants.has(entry.id)) {
				hasPostCompactionUsage = true;
				break;
			}
		}
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	// At the model's tokenizer ratio, as the compaction trigger counts.
	const estimate = estimateLeafContextTokens(projection, sessionManager, model);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}

/** Text of the last assistant message, skipping an aborted one with no content (for /copy). */
export function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}
