import type { SetupPick, FeatureContext } from "../../core/features/index.ts";
import {
	CLEARED_RESULTS_TYPE,
	contextMessages,
	contextReads,
	type MessageRef,
	sessionCleared,
	toolCallArguments,
} from "../files/reads.ts";
import type { FileGuard } from "../files/tool/guard.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { estimateTokens } from "../../core/compaction/tokens.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import { trailingUpdateRewritesPrefix, type TranscriptModel } from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN, charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { readPaths } from "../shared/home.ts";
import { outputDirOnce } from "../shared/spill.ts";
import { cacheClock, cacheCold } from "./cache.ts";
import { type Candidate, clearableResults, fileInputs, olderCandidates, savedCopy } from "./clearing-candidates.ts";
import {
	cachePrices,
	catalogPrices,
	clearingPays,
	clearingSaving,
	expectedRemainingRequests,
	realizedRequestsRatio,
	type ClearingCost,
} from "./clearing-cost.ts";
import { clearedPlaceholder, resultDigest, sessionClearedView } from "./clearing-view.ts";
import { historyReplaced } from "./history-cache.ts";
import { untrustedResult } from "./untrusted-results.ts";

export { KEEP_RECENT_RESULTS } from "./clearing-candidates.ts";

/**
 * Clearing old tool results when that costs less than re-sending them.
 *
 * Before every request, whether it starts a run or follows a tool inside one, the old results of tools whose output can
 * be fetched again, and the payloads of old `file` changes (on disk once they applied), are replaced by placeholders,
 * keeping the newest `KEEP_RECENT_RESULTS` of each (`clearing-candidates.ts`), when they total at least the floor and
 * either:
 *
 * - the request rewrites the cache anyway: it was last used (the last reply, or a refresh by Octocode's warmer) longer
 *   ago than its lifetime, a compaction replaced the history, the model changed, or a system update folds into the
 *   leading prompt. These points batch the clearing: it adds no cache write, so everything old goes, from the lower
 *   `CLEAR_AT_FREE_POINT_TOKENS`; or
 * - clearing pays while the cache is warm: the cost of re-sending the old results over the requests still expected
 *   exceeds the one-time cache write clearing causes (`clearing-cost.ts` holds the formula and its inputs; the expected
 *   requests are held to what this session's earlier clearings realized, `realizedRequestsRatio`). Then the run of old
 *   results that saves most is cleared, which may start after a large message that stays (`bestRun`), from
 *   `CLEAR_AT_LEAST_TOKENS`.
 *
 * A repeated-read note (`files/dedupe`) that points at a cleared result gets the same placeholder, so it never points
 * "above" at text that is gone.
 *
 * Nothing is lost: each result's whole text is saved first and the placeholder names the file (a `bash` result whose
 * output Octocode spilled already has one, holding the command's whole output) with a digest of what it held; a result
 * that cannot be saved stays. A `file` payload is already on disk and keeps its size and hash. The decision is a session
 * entry (`CLEARED_RESULTS_TYPE`) that every request applies the same way (`clearing-view.ts`), so the prompt stays
 * byte-stable between requests and survives a resume, reload or fork. The entry also records what the decision rested
 * on, why it ran (`trigger`) and the requests it expected, so the profiler and the cache statistics can compare it with
 * what followed.
 */

/** While the cache is warm, the text the older results must total (in tokens, by `CHARS_PER_TOKEN`) for any clearing to happen: below it the saving is too small to be worth a changed prefix and the saved copies. */
export const CLEAR_AT_LEAST_TOKENS = 20_000;
/** Where the request rewrites the cache anyway, the floor: the changed prefix costs nothing there, only the saved copies do. */
export const CLEAR_AT_FREE_POINT_TOKENS = 4_000;
// Both stay absolute, not scaled by the window: clearing is priced (`clearingPays`), and freeing a number of tokens saves
// the same per request whatever the window holds.

/** About what one placeholder costs in tokens (its saved path and digest are not known before the decision). */
const PLACEHOLDER_TOKENS = charsToTokens(clearedPlaceholder("x".repeat(120), "x".repeat(60)).length);

/** Why a clearing ran, recorded beside it: `warm` when it paid on a warm cache, anything else a rewrite that happened anyway. */
type ClearingTrigger = "idle" | "compaction" | "model" | "prompt" | "rewrite" | "warm";

/**
 * What makes the request about to be made rewrite the history's cache entry anyway, if anything: the way the model's
 * transcript is sent changes the leading prompt for the trailing system updates (`prompt`; `trailingUpdateRewritesPrefix`:
 * never for a model that keeps them in the history, only when a collapsing model folds one into the leading message or
 * changes its tools), or the model is not the one that answered last (`model`, a switch). A reply records the physical
 * model that answered, so a virtual (routed) model is never compared with it: its router picks the physical model per
 * request.
 */
export function rewriteCause(
	messages: readonly unknown[],
	model: (TranscriptModel & { provider?: string; id?: string; api?: string }) | undefined,
): "prompt" | "model" | undefined {
	if (trailingUpdateRewritesPrefix(messages.filter(isRecord) as { role: string }[], model)) return "prompt";
	if (!model?.provider || !model.id || (model.api !== undefined && isVirtualModel({ api: model.api })))
		return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
		return message.provider !== model.provider || message.model !== model.id ? "model" : undefined;
	}
	return undefined;
}

/** Whether the request about to be made rewrites the history's cache entry anyway (`rewriteCause`). */
export function prefixRewritten(
	messages: readonly unknown[],
	model: (TranscriptModel & { provider?: string; id?: string; api?: string }) | undefined,
): boolean {
	return rewriteCause(messages, model) !== undefined;
}

/**
 * The assistant messages of `messages` that came after the branch's last compaction: the ones the context has seen
 * since it was summarized. The projection lists the replies kept from before the compaction too, but they are not
 * requests the old results will be re-sent by. A branch without a compaction counts every reply.
 */
function repliesSinceCompaction(branch: readonly unknown[], messages: readonly MessageRef[]): MessageRef[] {
	const replies = messages.filter(({ message }) => isRecord(message) && message.role === "assistant");
	let compaction = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") {
			compaction = index;
			break;
		}
	}
	if (compaction < 0) return replies;
	const later = new Set(branch.slice(compaction + 1).map((entry) => (isRecord(entry) ? entry.id : undefined)));
	return replies.filter(({ id }) => later.has(id));
}

/** The prompt a reply's request sent, in tokens (input, cache read and cache write), when its usage says. */
function promptTokens(reply: MessageRef | undefined): number | undefined {
	const usage = isRecord(reply?.message) && isRecord(reply.message.usage) ? reply.message.usage : undefined;
	if (!usage) return undefined;
	const total = [usage.input, usage.cacheRead, usage.cacheWrite].reduce<number>(
		(sum, part) => sum + (typeof part === "number" ? part : 0),
		0,
	);
	return total > 0 ? total : undefined;
}

/**
 * The older candidates to clear (`older`, oldest first): all of them when the request rewrites the cache anyway; else
 * the run from the oldest one on whose clearing saves most (`clearingSaving`), of those that free
 * `CLEAR_AT_LEAST_TOKENS` and pay. A later start clears fewer but rewrites less of the cache. Empty when none pays.
 */
function bestRun(
	older: readonly Candidate[],
	tokensOf: (list: readonly Candidate[]) => number,
	costOf: (list: readonly Candidate[]) => ClearingCost,
	pays: (list: readonly Candidate[]) => boolean,
): readonly Candidate[] {
	if (older.length === 0 || costOf(older).rewriteAnyway) return pays(older) ? older : [];
	let best: readonly Candidate[] = [];
	let bestSaving = 0;
	for (let start = 0; start < older.length; start++) {
		const run = older.slice(start);
		// Later runs only hold fewer of the old tokens.
		if (tokensOf(run) < CLEAR_AT_LEAST_TOKENS) break;
		const saving = clearingSaving(costOf(run));
		if (saving > bestSaving && pays(run)) [best, bestSaving] = [run, saving];
	}
	return best;
}

/** The previous request's cache read in tokens, as its reply reported it. */
function lastCacheRead(messages: readonly MessageRef[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index].message;
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
		return typeof message.usage.cacheRead === "number" ? message.usage.cacheRead : undefined;
	}
	return undefined;
}

/** What the request about to be made tells the clearing decision besides the cache clock: see `clearStaleResults`. */
export interface ClearingOccasion {
	/** The request rewrites the prefix anyway: why (`rewriteCause`), or `true` when the caller knows only that it does. */
	rewrite?: boolean | "prompt" | "model";
	/** The context size in tokens at which a compaction summarizes the old results anyway (the window less the output reserve). */
	contextWindow?: number;
	/** The context's size in tokens as the last reply reported it; else estimated from the messages. */
	contextTokens?: number;
}

/** Why the request rewrites the cache anyway, if it does: the lifetime passed, a compaction replaced the history, or `occasion`. */
function freePoint(
	ctx: FeatureContext,
	ttlMs: number | undefined,
	occasion: ClearingOccasion,
	now: number,
): ClearingTrigger | undefined {
	if (cacheCold(ctx.sessionManager, ttlMs, now)) return "idle";
	if (historyReplaced(ctx.sessionManager)) return "compaction";
	if (occasion.rewrite === "prompt" || occasion.rewrite === "model") return occasion.rewrite;
	return occasion.rewrite === true ? "rewrite" : undefined;
}

/**
 * Clears the old results and `file` payloads when the request rewrites the cache anyway (`freePoint`), or when clearing
 * pays while it is warm (`clearingPays`): saves each result, records the decision with `api.session.appendEntry`, and
 * makes the file guard forget the files whose read was cleared and that no read left in the context still shows (the
 * rule `contextReads` rebuilds the guard by on a resume). Does nothing when neither applies, the session has no reply
 * yet, the model's cache lifetime is unknown and nothing rewrites the cache, or less than the floor would be freed.
 */
export function clearStaleResults(
	api: SetupPick<"session", "appendEntry">,
	ctx: FeatureContext,
	guard: Pick<FileGuard, "forget">,
	ttlMs: number | undefined,
	occasion: ClearingOccasion = {},
	now = Date.now(),
): void {
	if (cacheClock(ctx.sessionManager).useAt === undefined) return;
	const free = freePoint(ctx, ttlMs, occasion, now);
	const rewriteAnyway = free !== undefined;
	// Without a known lifetime there is no cache to price: only a rewrite that happens anyway clears.
	if (ttlMs === undefined && !rewriteAnyway) return;
	const floor = rewriteAnyway ? CLEAR_AT_FREE_POINT_TOKENS : CLEAR_AT_LEAST_TOKENS;
	const messages = contextMessages(ctx);
	const view = sessionClearedView(ctx.sessionManager);
	const older = olderCandidates(
		[...clearableResults(messages), ...fileInputs(messages)],
		sessionCleared(ctx.sessionManager),
		new Set(view.inputs.keys()),
	);
	const tokensOf = (list: readonly Candidate[]) =>
		list.reduce((chars, candidate) => chars + candidate.text.length, 0) / CHARS_PER_TOKEN;
	// Most requests stop here: the old results are too few to be worth a changed prefix and the saved copies.
	if (tokensOf(older) < floor) return;
	const tokens = messages.map(({ message }) => estimateTokens(message as never));
	// Tokens from each message to the end, so pricing a run from any start is one lookup.
	const suffixFrom = tokens.reduceRight<number[]>((sums, each, index) => {
		sums[index] = each + (sums[index + 1] ?? 0);
		return sums;
	}, []);
	const branch: readonly unknown[] = ctx.sessionManager.getBranch?.() ?? [];
	const replies = repliesSinceCompaction(branch, messages);
	const contextTokens = occasion.contextTokens ?? suffixFrom[0] ?? 0;
	const prices = cachePrices(ctx.model, ttlMs ?? 0);
	const calibration = realizedRequestsRatio(branch, CLEARED_RESULTS_TYPE);
	const remainingRequests =
		expectedRemainingRequests(replies.length, contextTokens, occasion.contextWindow, promptTokens(replies[0])) *
		(calibration ?? 1);
	const costOf = (list: readonly Candidate[]): ClearingCost => {
		const oldTokens = tokensOf(list);
		const suffix = list.length === 0 ? 0 : (suffixFrom[list[0].index] ?? 0);
		const suffixTokensAfter = Math.max(0, suffix - oldTokens) + list.length * PLACEHOLDER_TOKENS;
		return { oldTokens, suffixTokensAfter, remainingRequests, prices, rewriteAnyway };
	};
	const pays = (list: readonly Candidate[]): boolean =>
		list.length > 0 && tokensOf(list) >= floor && clearingPays(costOf(list));
	const chosen = bestRun(older, tokensOf, costOf, pays);
	if (chosen.length === 0) return;
	// One output folder for the batch: resolving it per result repeated the workspace's realpath and folder checks.
	const outputDir = outputDirOnce();
	const calls = toolCallArguments(messages);
	const saved = chosen.flatMap((candidate): Array<{ candidate: Candidate; file: string | undefined }> => {
		// A `file` payload is on disk already; a result's whole text is saved first.
		if (candidate.kind === "input") return [{ candidate, file: undefined }];
		const file = savedCopy(candidate, outputDir);
		return file ? [{ candidate, file }] : [];
	});
	// Results that could not be saved stay; if what is left no longer pays, the saved copies stay unused.
	const clearedCandidates = saved.map(({ candidate }) => candidate);
	if (!pays(clearedCandidates)) return;
	const results = saved.flatMap(({ candidate, file }) => {
		if (file === undefined) return [];
		const message = messages[candidate.index].message;
		const details = isRecord(message) ? message.details : undefined;
		const trusted = !untrustedResult(candidate.tool, calls.get(candidate.id), details);
		return [{ id: candidate.id, saved: file, digest: resultDigest(candidate.text, candidate.tool, details, trusted) }];
	});
	const inputs = clearedCandidates.filter((candidate) => candidate.kind === "input").map((candidate) => candidate.id);
	// Notes pointing at a result cleared now or earlier take that result's placeholder.
	const savedOf = new Map([
		...sessionCleared(ctx.sessionManager),
		...results.map(({ id, saved: file }) => [id, file] as const),
	]);
	const digestOf = new Map([...view.digests, ...results.map(({ id, digest }) => [id, digest] as const)]);
	const notes: Array<{ id: string; saved: string; digest?: string }> = [];
	for (const { message } of messages) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		const target = isRecord(message.details) ? message.details.unchangedOf : undefined;
		if (typeof target !== "string") continue;
		const file = savedOf.get(target);
		const id = String(message.toolCallId);
		const digest = digestOf.get(target);
		if (file !== undefined && !savedOf.has(id)) notes.push({ id, saved: file, ...(digest ? { digest } : {}) });
	}
	// What the decision rested on, so the profiler can compare it with what the next request cost (`profiler/clearing-ledger.ts`).
	const decided = costOf(clearedCandidates);
	const cacheRead = lastCacheRead(messages);
	api.session.appendEntry(CLEARED_RESULTS_TYPE, {
		results: [...results, ...notes],
		...(inputs.length > 0 ? { inputs } : {}),
		oldTokens: Math.round(decided.oldTokens),
		suffixTokens: Math.round(decided.suffixTokensAfter),
		remainingRequests: Math.round(decided.remainingRequests * 10) / 10,
		requestsSoFar: replies.length,
		...(calibration === undefined ? {} : { calibration: Math.round(calibration * 100) / 100 }),
		prices: { ...prices, unit: catalogPrices(ctx.model, ttlMs ?? 0) ? "usd-per-million" : "ratio" },
		rewriteAnyway,
		trigger: free ?? "warm",
		...(cacheRead === undefined ? {} : { cacheRead }),
	});
	// The entry is in the branch now (`appendEntry` is synchronous), so `contextReads` sees the context as cleared.
	const shown = new Set(contextReads(ctx).map((read) => canonicalPath(read.file)));
	for (const { candidate, file } of saved) {
		if (file === undefined) continue;
		const args = calls.get(candidate.id);
		for (const read of args ? readPaths(candidate.tool, args, ctx.cwd) : [])
			if (!shown.has(canonicalPath(read))) guard.forget(read);
	}
}
