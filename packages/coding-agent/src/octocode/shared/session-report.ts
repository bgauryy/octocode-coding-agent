/** The session statistics block of `/status`: messages, tokens, cache and cost. Text only; the caller supplies styling. */

import { computeCacheWaste, type ModelPriceSource } from "../../core/cache-stats.ts";
import { formatTurnCosts } from "../../core/cache-warmer/format.ts";
import { turnCosts } from "../../core/cache-warmer/turn-costs.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { SessionStats } from "../../core/session-stats.ts";
import { getUsageCostBreakdown } from "../../core/usage-totals.ts";
import { plural } from "@octocodeai/octocode-common/clip";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { cachedPercent, formatCost, formatTokens } from "./format.ts";

export interface ReportStyle {
	bold(text: string): string;
	dim(text: string): string;
}

const PLAIN_STYLE: ReportStyle = { bold: (text) => text, dim: (text) => text };

/** Money as the footer and `/usage` write it (`≈$1.24`, `≈$<0.01`): an estimate at list prices; `≈$0` when nothing was spent. */
const money = (cost: number): string => formatCost({ cost, unpriced: false }) || "≈$0";

export interface SessionReportInput {
	stats: SessionStats;
	/** Every entry of the session, all branches: totals (cost, cache) cover all that was spent. */
	entries: SessionEntry[];
	/** The current branch, root first: $/turn counts only the turns the conversation still holds. */
	branch: SessionEntry[];
	prices: ModelPriceSource;
	/** `provider/id` of the selected model; a single usage entry for it is not listed again under Cost. */
	selectedModelKey: string;
	/** The model line of Session Info (`openai/gpt-5:high`); none without a model. */
	model?: string;
	name?: string;
	/** Shell command that resumes the session, when there is one. */
	resumeCommand?: string;
	/** Heading lines of a section drawn after the cache figures, such as cache warming. Already styled. */
	afterCache?: string;
}

/** The report text, without a trailing newline. */
export function formatSessionReport(input: SessionReportInput, style: ReportStyle = PLAIN_STYLE): string {
	const { stats, selectedModelKey } = input;
	const { bold, dim } = style;
	const cacheWaste = computeCacheWaste(input.entries, input.prices);
	// Usage without model attribution is grouped separately so the breakdown reconciles with the session total.
	const usageBreakdown = getUsageCostBreakdown(input.entries);
	let info = `${bold("Session Info")}\n\n`;
	if (input.name) info += `${dim("Name:")} ${input.name}\n`;
	info += `${dim("File:")} ${stats.sessionFile ? homeTilde(stats.sessionFile) : "In-memory"}\n`;
	info += `${dim("ID:")} ${stats.sessionId}\n`;
	if (input.model !== undefined) info += `${dim("Model:")} ${input.model}\n`;
	if (input.resumeCommand) info += `${dim("Resume:")} ${input.resumeCommand}\n`;
	info += `\n${bold("Messages")}\n`;
	// The parts add up to the total: messages that are none of these (notices, summaries, shell runs) are `other`.
	const other = stats.totalMessages - stats.userMessages - stats.assistantMessages - stats.toolResults;
	info += `${dim("Total:")} ${stats.totalMessages}\n`;
	info += `${dim("User:")} ${stats.userMessages}\n`;
	info += `${dim("Assistant:")} ${stats.assistantMessages}\n`;
	info += `${dim("Tool results:")} ${stats.toolResults} ${dim(`(${plural(stats.toolCalls, "call")})`)}\n`;
	if (other > 0) info += `${dim("Other:")} ${other}\n`;
	info += "\n";
	info += `${bold("Tokens")}\n`;
	// "Input" is the full prompt volume. With cache activity, split it into cached (served from cache) and uncached
	// (everything else), the only provider-independent split; cache writes are a detail of the uncached part.
	const { input: fresh, cacheRead, cacheWrite } = stats.tokens;
	const promptTokens = fresh + cacheRead + cacheWrite;
	info += `${dim("Input:")} ${promptTokens.toLocaleString()}\n`;
	if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
		const hitRate = dim(`(${cachedPercent(cacheRead, promptTokens, 1)?.toFixed(1)}%)`);
		info += `  ${dim("Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
		const written = cacheWrite > 0 ? ` ${dim(`(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
		info += `  ${dim("Uncached:")} ${(fresh + cacheWrite).toLocaleString()}${written}\n`;
	}
	info += `${dim("Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	info += `${dim("Total:")} ${stats.tokens.total.toLocaleString()}\n`;
	if (stats.thinkingReduced > 0)
		info += `${dim("Thinking budget reduced:")} ${plural(stats.thinkingReduced, "request")}\n`;

	const conversationCache = stats.cache.conversation;
	const hitRate = conversationCache.hitRate === null ? "Unknown" : `${(conversationCache.hitRate * 100).toFixed(1)}%`;
	info += `${dim("Conversation cache hits:")} ${hitRate} ${dim(`(${plural(conversationCache.requests, "request")})`)}\n`;
	const refreshUsage = stats.cache.warming;
	// No refresh yet: no money figure, so a bare ≈$0 never reads as a cost.
	const refreshed =
		refreshUsage.requests > 0 ? `${plural(refreshUsage.requests, "request")}, ${money(refreshUsage.cost)}` : "none";
	info += `${dim("Recorded refresh usage:")} ${refreshed}\n`;
	if (input.afterCache) info += `\n${input.afterCache}`;

	// Tokens a plan paid for (an external runner on its subscription) are listed as `(sub)`, never as a $0 cost.
	const planPaid = usageBreakdown.some((entry) => entry.plan);
	if (stats.cost > 0 || planPaid || cacheWaste.missedTokens > 0 || stats.lowerBoundEntries > 0) {
		info += `\n${bold("Cost")}\n`;
		info += `${dim("Total:")} ${stats.cost > 0 || !planPaid ? money(stats.cost) : "(sub)"}`;
		if (stats.lowerBoundEntries > 0) {
			const dropped = stats.lowerBoundEntries === 1 ? "1 response" : `${stats.lowerBoundEntries} responses`;
			info += ` ${dim(`(at least: ${dropped} without the provider's final count)`)}`;
		}
		// A single entry repeats the total, unless it names a model other than the selected one.
		if (usageBreakdown.length > 1 || usageBreakdown[0]?.key !== selectedModelKey) {
			for (const entry of usageBreakdown) {
				const cost = entry.plan ? "(sub)" : money(entry.cost);
				info += `\n  ${dim(`${entry.key}:`)} ${cost} ${dim(`(${formatTokens(entry.tokens)} tokens)`)}`;
			}
		}
		if (cacheWaste.missedTokens > 0) {
			const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
			const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
			info +=
				cacheWaste.missedCost >= 0.0001
					? `\n${dim("Estimated cache re-billing:")} ${money(cacheWaste.missedCost)} ${dim(`(${detail})`)}`
					: `\n${dim("Estimated cache re-billing:")} ${detail}`;
		}
	}
	const perTurn = formatTurnCosts(turnCosts(input.branch), dim);
	if (perTurn) info += `\n\n${bold("Turns")}\n${perTurn.trimEnd()}`;
	return info;
}
