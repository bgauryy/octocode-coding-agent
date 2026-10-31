import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { finiteOrZero } from "../shared/util.ts";
import { formatTokens } from "../shared/format.ts";

/** Conversation requests only: compaction, warming and nested tools have separate usage receipts. */
export interface ChildCacheMetrics {
	requests: number;
	promptTokens: number;
	cacheRead: number;
	cacheWrite: number;
	latest: { promptTokens: number; cacheRead: number; cacheWrite: number; reason?: string };
}

/** Read share is token-weighted; an empty provider receipt cannot establish a rate. */
export function childCacheLabel(cache: Pick<ChildCacheMetrics, "promptTokens" | "cacheRead" | "cacheWrite">): string {
	const rate = cache.promptTokens > 0 ? `${Math.round((cache.cacheRead / cache.promptTokens) * 100)}%` : "n/a";
	return `${rate} cached · ${formatTokens(cache.cacheRead)} read · ${formatTokens(cache.cacheWrite)} written`;
}

/** One completed assistant reply, kept separately from the run's total spend. */
export function noteChildCache(
	previous: ChildCacheMetrics | undefined,
	reply: Record<string, unknown>,
): ChildCacheMetrics | undefined {
	if (!isRecord(reply.usage)) return previous;
	const cacheRead = finiteOrZero(reply.usage.cacheRead);
	const cacheWrite = finiteOrZero(reply.usage.cacheWrite);
	const promptTokens = finiteOrZero(reply.usage.input) + cacheRead + cacheWrite;
	const diagnostic = Array.isArray(reply.diagnostics)
		? reply.diagnostics.find((item) => isRecord(item) && item.type === "cache_miss")
		: undefined;
	const reason = isRecord(diagnostic) && isRecord(diagnostic.details) ? diagnostic.details.reason : undefined;
	return {
		requests: (previous?.requests ?? 0) + 1,
		promptTokens: (previous?.promptTokens ?? 0) + promptTokens,
		cacheRead: (previous?.cacheRead ?? 0) + cacheRead,
		cacheWrite: (previous?.cacheWrite ?? 0) + cacheWrite,
		latest: { promptTokens, cacheRead, cacheWrite, ...(typeof reason === "string" ? { reason } : {}) },
	};
}
