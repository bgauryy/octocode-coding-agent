import { activeRates, type AssistantMessage, type ModelCost, type Usage } from "@octocodeai/octocode-ai";
import type { SessionEntry } from "./session-manager.ts";
import { customMessageUsage } from "./usage-totals.ts";

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
	/** Prompt tokens that were in the previous turn's prompt but not read from cache. */
	missedTokens: number;
	/** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
	missedCost: number;
	/** Milliseconds since the previous request (which last refreshed the cache). */
	idleMs: number;
	/** True when the model changed relative to the previous request. */
	modelChanged: boolean;
	/**
	 * True when nothing was read from the cache, so the instructions (system prompt and tools) were re-billed with the
	 * history. False when the request still read a cached prefix: only history after it was re-billed.
	 */
	fullMiss: boolean;
	/** True when an instruction or tool update (a system message) entered the conversation since the previous request. */
	promptChanged: boolean;
	/**
	 * How the history already sent was rewritten since the previous request, which moves the cached prefix: old tool
	 * results replaced by placeholders on a warm cache (`cleared-results`, Octocode's clearing) or an entry edited in place
	 * (`context-edit`).
	 */
	contextChange?: ContextChange;
	/** Why the provider says the prefix diverged (`OCTOCODE_CACHE_DIAGNOSTICS`), for example `tools_changed`. */
	apiReason?: string;
}

/** A rewrite of history that was already sent; see {@link CacheMiss.contextChange}. */
type ContextChange = "cleared-results" | "context-edit";

/** The custom entry Octocode's tool-result clearing writes when it replaces old results with placeholders. */
const CLEARED_RESULTS_ENTRY = "octocode-cleared-results";

/**
 * Whether a clearing entry broke a warm cache: its `trigger` is `warm` (it paid on its own). A clearing at a point that
 * rewrote the cache anyway (`idle`, `compaction`, a model or prompt change) breaks nothing. An entry from before
 * `trigger` was recorded counts unless it says `rewriteAnyway`.
 */
function clearingBrokeCache(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return true;
	const { trigger, rewriteAnyway } = data as { trigger?: unknown; rewriteAnyway?: unknown };
	return trigger === undefined ? rewriteAnyway !== true : trigger === "warm";
}

const CONTEXT_CHANGE_CAUSE: Record<ContextChange, string> = {
	"cleared-results": "after tool-result clearing",
	"context-edit": "after context edit",
};

/** The reason the provider reported for this reply's miss, from the `cache_miss` diagnostic the adapter records. */
function apiMissReason(message: AssistantMessage): string | undefined {
	const reason = message.diagnostics?.find((diagnostic) => diagnostic.type === "cache_miss")?.details?.reason;
	return typeof reason === "string" ? reason : undefined;
}

/**
 * The area a miss re-billed and its likely cause. The cause is a model switch, an instruction or tool update, an idle
 * gap past a known `ttlMs` (the lifetime of the history entry the previous request wrote), or else a rewrite of the
 * history already sent: tool-result clearing or a context edit. An idle gap outranks a rewrite, since clearing after
 * the entry expired costs nothing extra; an unknown lifetime or shorter gap with no rewrite does not explain the miss,
 * so none is named. The area is "Full" when the instructions were re-billed too, "History" when a cached prefix was
 * still read.
 */
export function cacheMissLabel(miss: CacheMiss, ttlMs?: number): string {
	// The provider compared the two requests; that outranks every inference below.
	if (miss.apiReason)
		return `${miss.fullMiss ? "Full" : "History"} cache miss: provider reports ${miss.apiReason.replaceAll("_", " ")}`;
	if (miss.modelChanged) return "Cache miss after model switch";
	if (miss.promptChanged) return "Cache miss after instruction or tool update";
	const area = miss.fullMiss ? "Full cache miss" : "History cache miss";
	if (ttlMs !== undefined && miss.idleMs >= ttlMs) return `${area} after ${Math.round(miss.idleMs / 60_000)}m idle`;
	if (miss.contextChange) return `${area} ${CONTEXT_CHANGE_CAUSE[miss.contextChange]}`;
	return area;
}

interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** Number of counted misses (turns above the noise floor). */
	missCount: number;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: ModelCost } | undefined;
}

/** The model's cache-read price per token at the time `message` was billed, 0 when the model is unknown. */
export function cacheReadRatePerToken(models: ModelPriceSource, message: AssistantMessage): number {
	const model = models.getModel(message.provider, message.model);
	return model ? activeRates(model.cost, message.timestamp).cacheRead / 1_000_000 : 0;
}

/** The last request seen by the scan; everything in its prompt should be cached. */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * Sticky: some earlier request in this scan segment reported cache activity.
	 * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
	 * writes unreported) from a provider that never reports caching at all.
	 */
	reportedCache: boolean;
	/** A system message (instruction or tool update) was recorded after this request. */
	promptChanged: boolean;
	/** The latest rewrite of already-sent history recorded after this request. */
	contextChange?: ContextChange;
}

/**
 * The model a request was answered by: the concrete model the provider reported (a dated snapshot of an alias, or the
 * model a router chose), else the requested one. Cache refreshes record the same, so both compare alike.
 */
function modelKeyOf(message: Pick<AssistantMessage, "provider" | "model" | "responseModel">): string {
	return `${message.provider}/${message.responseModel ?? message.model}`;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : cacheReadRatePerToken(models, message);

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: modelKeyOf(message) !== prev.modelKey,
		fullMiss: usage.cacheRead === 0,
		promptChanged: prev.promptChanged,
		...(prev.contextChange ? { contextChange: prev.contextChange } : {}),
		...(apiMissReason(message) ? { apiReason: apiMissReason(message) } : {}),
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: modelKeyOf(message),
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
		promptChanged: false,
	};
}

/**
 * Walks entries in file order. The previous request of an entry is the state after its parent, not after the entry
 * written just before it: after `/tree` or a fork point the file holds several branches, and a reply on one branch
 * must not be compared with the prompt of another.
 */
function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();
	const stateAfter = new Map<string, PreviousRequest | undefined>();

	for (const entry of entries) {
		prev = entry.parentId ? stateAfter.get(entry.parentId) : undefined;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// The context legitimately changed; the next turn's prompt is new content,
			// not re-billed content. Model switches are NOT exempt: they re-bill the
			// full prompt and should be counted.
			prev = undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0) {
				prev = {
					promptTokens,
					modelKey: `${entry.provider}/${entry.model}`,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
					promptChanged: prev?.promptChanged ?? false,
					...(prev?.contextChange ? { contextChange: prev.contextChange } : {}),
				};
			}
		} else if (entry.type === "message" && entry.message.role === "system") {
			if (prev) prev = { ...prev, promptChanged: true };
		} else if (entry.type === "context_edit") {
			if (prev) prev = { ...prev, contextChange: "context-edit" };
		} else if (
			entry.type === "custom" &&
			entry.customType === CLEARED_RESULTS_ENTRY &&
			clearingBrokeCache(entry.data)
		) {
			if (prev) prev = { ...prev, contextChange: "cleared-results" };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
		stateAfter.set(entry.id, prev);
	}
	return { prev, totals, misses };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}

interface CacheUsageMetrics {
	/**
	 * Recorded requests that reported prompt tokens, as the profiler counts them: a reply that failed or was aborted
	 * before the provider counted it reports none and is left out (its cost, if any, still counts). Tool usage may
	 * aggregate child requests.
	 */
	requests: number;
	promptTokens: number;
	cacheRead: number;
	cacheWrite: number;
	/** Token-weighted cache reads / prompt tokens, or null without input usage. */
	hitRate: number | null;
	cost: number;
}

export type CacheMetrics = Record<
	"conversation" | "warming" | "compaction" | "branchSummary" | "tools" | "other",
	CacheUsageMetrics
>;

/** Separate real conversation usage from auxiliary requests so refreshes cannot inflate its hit rate. */
export function computeCacheMetrics(entries: readonly SessionEntry[]): CacheMetrics {
	const empty = (): CacheUsageMetrics => ({
		requests: 0,
		promptTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		hitRate: null,
		cost: 0,
	});
	const metrics: CacheMetrics = {
		conversation: empty(),
		warming: empty(),
		compaction: empty(),
		branchSummary: empty(),
		tools: empty(),
		other: empty(),
	};
	const add = (purpose: keyof CacheMetrics, usage: Usage): void => {
		const target = metrics[purpose];
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt > 0) target.requests++;
		target.promptTokens += prompt;
		target.cacheRead += usage.cacheRead;
		target.cacheWrite += usage.cacheWrite;
		target.cost += usage.cost.total;
		target.hitRate = target.promptTokens > 0 ? target.cacheRead / target.promptTokens : null;
	};
	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") add("conversation", entry.message.usage);
			else if (entry.message.role === "toolResult" && entry.message.usage) add("tools", entry.message.usage);
		} else if (entry.type === "usage") {
			add(
				entry.kind === "cache_warm" ? "warming" : entry.kind === "compaction_attempt" ? "compaction" : "other",
				entry.usage,
			);
		} else if (entry.type === "compaction" && entry.usage) add("compaction", entry.usage);
		else if (entry.type === "branch_summary" && entry.usage) add("branchSummary", entry.usage);
		else if (entry.type === "custom_message") {
			const usage = customMessageUsage(entry);
			if (usage) add("tools", usage);
		}
	}
	return metrics;
}
