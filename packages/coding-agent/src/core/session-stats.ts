import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { type CacheMetrics, computeCacheMetrics } from "./cache-stats.ts";
import { calculateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { estimateProjectedContextTokens } from "./compaction/index.ts";
import type { ContextUsage } from "./extensions/index.ts";
import { getLatestCompactionEntry, type SessionManager } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

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
	contextUsage?: ContextUsage;
	cache: CacheMetrics;
}

/** Message counts, token and cost totals, and cache metrics of the session file's entries. */
export function computeSessionStats(
	sessionManager: SessionManager,
	session: Pick<SessionStats, "sessionFile" | "sessionId" | "contextUsage">,
): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();

	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsageToTotals(usageTotals, entry.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usageTotals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				addUsageToTotals(usageTotals, message.usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(usageTotals, assistantMsg.usage);
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
		cache: computeCacheMetrics(sessionManager.getEntries()),
		contextUsage: session.contextUsage,
	};
}

/** How full `model`'s context window is with the current branch; unknown tokens right after a compaction. */
export function computeContextUsage(
	sessionManager: SessionManager,
	model: Model<any> | undefined,
): ContextUsage | undefined {
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	const projection = sessionManager.buildSessionProjection();
	const branch = sessionManager.getBranch();
	const latestCompaction = getLatestCompactionEntry(branch);

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
		const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
		const hasPostCompactionUsage = branch.slice(compactionIndex + 1).some((entry) => projectedAssistants.has(entry.id));
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branch);
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
