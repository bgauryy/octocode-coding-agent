import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import {
	CLEARED_RESULTS_TYPE,
	contextMessages,
	contextReads,
	type MessageRef,
	plainText,
	sessionCleared,
	toolCallArguments,
} from "../files/reads.ts";
import type { FileGuard } from "../files/tool/guard.ts";
import { readOnlyCommand } from "../permission/shell/read-only.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { estimateTokens } from "../../core/compaction/tokens.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import { trailingUpdateRewritesPrefix, type TranscriptModel } from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { shortPath } from "../../utils/display-path.ts";
import { readPaths } from "../shared/home.ts";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { outputDirOnce, saveContentCopy } from "../shared/spill.ts";
import { cacheClock, cacheCold } from "./cache.ts";
import {
	cachePrices,
	catalogPrices,
	clearingPays,
	expectedRemainingRequests,
	type ClearingCost,
} from "./clearing-cost.ts";

/**
 * Clearing old tool results when that costs less than re-sending them.
 *
 * Before every request, whether it starts a run or follows a tool inside one, the old results of tools whose output can
 * be fetched again are replaced by a placeholder, keeping the newest `KEEP_RECENT_RESULTS`, when they total at least
 * `CLEAR_AT_LEAST_TOKENS` and either:
 *
 * - the request rewrites the cache anyway: it was last used (the last reply, or a refresh by Octocode's warmer) longer
 *   ago than its lifetime, the model changed, or a system update folds into the leading prompt; or
 * - clearing pays while the cache is warm: the cost of re-sending the old results over the requests still expected
 *   exceeds the one-time cache write clearing causes (`clearing-cost.ts` holds the formula and its inputs).
 *
 * A repeated-read note (`files/dedupe`) that points at a cleared result gets the same placeholder, so it never points
 * "above" at text that is gone.
 *
 * Nothing is lost: each result's whole text is saved first and the placeholder names the file (a `bash` result whose
 * output Octocode spilled already has one, holding the command's whole output); a result that cannot be saved stays.
 * The decision is a session entry (`CLEARED_RESULTS_TYPE`) that every request applies the same way
 * (`applyClearedResults`), so the prompt stays byte-stable between requests and survives a resume, reload or fork.
 */

/** The newest clearable results always kept: the next step usually builds on the last few calls, and older ones come back by repeating the call or reading the saved file. */
export const KEEP_RECENT_RESULTS = 5;
/** The text the older results must total (in tokens, by `CHARS_PER_TOKEN`) for any clearing to happen: below it the saving is too small to be worth a changed prefix and the saved copies. */
export const CLEAR_AT_LEAST_TOKENS = 20_000;
// Both stay absolute, not scaled by the window: clearing is priced (`clearingPays`), and freeing a number of tokens saves
// the same per request whatever the window holds.

/**
 * `web` and every MCP tool result (`isMcpToolName`): its whole text is saved to a file before it is cleared, and the
 * placeholder names that file. Never `file` or `agent`; `bash` only for a read-only command (`readOnlyBash`), saved the
 * same way unless Octocode already spilled its whole output to a file.
 * `read`, `grep`, `find` and `ls` are no longer Octocode tools; they stay for resumed transcripts of other hosts that
 * hold their results, and for custom tools that still use those names.
 */
const CLEARABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "web"]);

const PLACEHOLDER_START = "[Old tool result cleared";

/** What stands for a cleared result; `saved` is where `saveContentCopy` put its whole text. */
function clearedPlaceholder(saved: string): string {
	return `${PLACEHOLDER_START} to save context. Full output: ${saved}. Read that file, or run the call again.]`;
}

/** About what one placeholder costs in tokens (its saved path is not known before the decision). */
const PLACEHOLDER_TOKENS = Math.ceil(clearedPlaceholder("x".repeat(120)).length / CHARS_PER_TOKEN);

interface Candidate {
	id: string;
	tool: string;
	text: string;
	/** The result's position in the context's messages. */
	index: number;
	/** A `bash` result's spill file, when Octocode saved its whole output; otherwise the text is saved when cleared. */
	spilled?: string;
}

/** The repeated-read note behind a result (`details.unchangedOf`: the call it points at), if it is one. */
function noteOf(message: Record<string, unknown>): string | undefined {
	const unchangedOf = isRecord(message.details) ? message.details.unchangedOf : undefined;
	return typeof unchangedOf === "string" ? unchangedOf : undefined;
}

/** Commands already judged by `readOnlyCommand`, which parses the shell line: every request asks again for the same calls. */
const readOnlyJudged = new Map<string, boolean>();
const JUDGED_LIMIT = 4_096;

/** Whether a `bash` call may be cleared: its command is read-only (`readOnlyCommand`), so repeating it is harmless. */
function readOnlyBash(args: Record<string, unknown> | undefined): boolean {
	const command = args?.command;
	if (typeof command !== "string") return false;
	const shell = args?.type === "powershell" ? "powershell" : "bash";
	const key = `${shell}\0${command}`;
	let judged = readOnlyJudged.get(key);
	if (judged === undefined) {
		if (readOnlyJudged.size >= JUDGED_LIMIT) readOnlyJudged.clear();
		judged = readOnlyCommand(command, shell);
		readOnlyJudged.set(key, judged);
	}
	return judged;
}

/** Successful results of clearable tools that show only text and are not placeholders or repeated-read notes, oldest first. */
function clearableResults(messages: readonly MessageRef[]): Candidate[] {
	const calls = toolCallArguments(messages);
	return messages.flatMap(({ message }, index) => {
		if (
			!isRecord(message) ||
			message.role !== "toolResult" ||
			message.isError === true ||
			typeof message.toolCallId !== "string" ||
			noteOf(message) !== undefined
		)
			return [];
		const tool = String(message.toolName);
		const bash = tool === "bash" && readOnlyBash(calls.get(message.toolCallId));
		const text = CLEARABLE_TOOLS.has(tool) || isMcpToolName(tool) || bash ? plainText(message.content) : undefined;
		if (text === undefined || text.startsWith(PLACEHOLDER_START)) return [];
		const spilled = bash && isRecord(message.details) ? message.details.fullOutputPath : undefined;
		return [{ id: message.toolCallId, tool, text, index, ...(typeof spilled === "string" ? { spilled } : {}) }];
	});
}

/** All but the newest `KEEP_RECENT_RESULTS` results not yet cleared. */
function olderResults(candidates: readonly Candidate[], cleared: ReadonlyMap<string, string>): Candidate[] {
	const open = candidates.filter((candidate) => !cleared.has(candidate.id));
	return open.slice(0, Math.max(open.length - KEEP_RECENT_RESULTS, 0));
}

/** Where a result's whole text is: Octocode's spill file of a `bash` command when it still exists, else a copy saved now. */
function savedCopy(candidate: Candidate, outputDir: () => string): string | undefined {
	if (candidate.spilled !== undefined && fs.existsSync(candidate.spilled)) return shortPath(candidate.spilled);
	return saveContentCopy(candidate.text, `cleared-${candidate.tool}`, "txt", outputDir);
}

/**
 * Whether the request about to be made rewrites the history's cache entry anyway: the way the model's transcript is
 * sent changes the leading prompt for the trailing system updates (`trailingUpdateRewritesPrefix`: never for a model
 * that keeps them in the history, only when a collapsing model folds one into the leading message or changes its
 * tools), or the model is not the one that answered last (a model switch). A reply records the physical model that
 * answered, so a virtual (routed) model is never compared with it: its router picks the physical model per request.
 */
export function prefixRewritten(
	messages: readonly unknown[],
	model: (TranscriptModel & { provider?: string; id?: string; api?: string }) | undefined,
) {
	if (trailingUpdateRewritesPrefix(messages.filter(isRecord) as { role: string }[], model)) return true;
	if (!model?.provider || !model.id || (model.api !== undefined && isVirtualModel({ api: model.api }))) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		if (typeof message.provider !== "string" || typeof message.model !== "string") return false;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
}

/**
 * The assistant messages of `messages` that came after the branch's last compaction: the ones the context has seen
 * since it was summarized. The projection lists the replies kept from before the compaction too, but they are not
 * requests the old results will be re-sent by. A branch without a compaction counts every reply.
 */
function repliesSinceCompaction(ctx: ExtensionContext, messages: readonly MessageRef[]): number {
	const replies = messages.filter(({ message }) => isRecord(message) && message.role === "assistant");
	const branch: unknown[] = ctx.sessionManager.getBranch?.() ?? [];
	let compaction = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isRecord(entry) && entry.type === "compaction") {
			compaction = index;
			break;
		}
	}
	if (compaction < 0) return replies.length;
	const later = new Set(branch.slice(compaction + 1).map((entry) => (isRecord(entry) ? entry.id : undefined)));
	return replies.filter(({ id }) => later.has(id)).length;
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
	/** The request rewrites the prefix anyway (`prefixRewritten`). */
	rewrite?: boolean;
	/** The context size in tokens at which a compaction summarizes the old results anyway (the window less the output reserve). */
	contextWindow?: number;
	/** The context's size in tokens as the last reply reported it; else estimated from the messages. */
	contextTokens?: number;
}

/**
 * Clears the old results when the request rewrites the cache anyway (the lifetime `ttlMs` has passed since the cache
 * was last used at `now`, or `occasion.rewrite`), or when clearing pays while it is warm (`clearingPays`): saves each,
 * records the decision with `api.appendEntry`, and makes the file guard forget the files whose read was cleared and that
 * no read left in the context still shows (the rule `contextReads` rebuilds the guard by on a resume). Does nothing
 * when neither applies, the session has no reply yet, the model's cache lifetime is unknown and nothing rewrites the
 * cache, or less than `CLEAR_AT_LEAST_TOKENS` would be freed.
 */
export function clearStaleResults(
	api: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	guard: Pick<FileGuard, "forget">,
	ttlMs: number | undefined,
	occasion: ClearingOccasion = {},
	now = Date.now(),
): void {
	if (cacheClock(ctx.sessionManager).useAt === undefined) return;
	const rewriteAnyway = cacheCold(ctx.sessionManager, ttlMs, now) || occasion.rewrite === true;
	// Without a known lifetime there is no cache to price: only a rewrite that happens anyway clears.
	if (ttlMs === undefined && !rewriteAnyway) return;
	const messages = contextMessages(ctx);
	const older = olderResults(clearableResults(messages), sessionCleared(ctx.sessionManager));
	const tokensOf = (list: readonly Candidate[]) =>
		list.reduce((chars, candidate) => chars + candidate.text.length, 0) / CHARS_PER_TOKEN;
	// Most requests stop here: the old results are too few to be worth a changed prefix and the saved copies.
	if (tokensOf(older) < CLEAR_AT_LEAST_TOKENS) return;
	const tokens = messages.map(({ message }) => estimateTokens(message as never));
	const requests = repliesSinceCompaction(ctx, messages);
	const contextTokens = occasion.contextTokens ?? tokens.reduce((sum, each) => sum + each, 0);
	const prices = cachePrices(ctx.model, ttlMs ?? 0);
	const remainingRequests = expectedRemainingRequests(requests, contextTokens, occasion.contextWindow);
	const costOf = (list: readonly Candidate[]): ClearingCost => {
		const oldTokens = tokensOf(list);
		const suffix = list.length === 0 ? 0 : tokens.slice(list[0].index).reduce((sum, each) => sum + each, 0);
		const suffixTokensAfter = Math.max(0, suffix - oldTokens) + list.length * PLACEHOLDER_TOKENS;
		return { oldTokens, suffixTokensAfter, remainingRequests, prices, rewriteAnyway };
	};
	const pays = (list: readonly Candidate[]): boolean =>
		list.length > 0 && tokensOf(list) >= CLEAR_AT_LEAST_TOKENS && clearingPays(costOf(list));
	if (!pays(older)) return;
	// One output folder for the batch: resolving it per result repeated the workspace's realpath and folder checks.
	const outputDir = outputDirOnce();
	const saved = older.flatMap((candidate) => {
		const file = savedCopy(candidate, outputDir);
		return file ? [{ candidate, file }] : [];
	});
	// Results that could not be saved stay; if what is left no longer pays, the saved copies stay unused.
	const clearedCandidates = saved.map(({ candidate }) => candidate);
	if (!pays(clearedCandidates)) return;
	const results = saved.map(({ candidate, file }) => ({ id: candidate.id, saved: file }));
	// Notes pointing at a result cleared now or earlier take that result's placeholder.
	const savedOf = new Map([
		...sessionCleared(ctx.sessionManager),
		...results.map(({ id, saved: file }) => [id, file] as const),
	]);
	for (const { message } of messages) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		const target = noteOf(message);
		const file = target === undefined ? undefined : savedOf.get(target);
		const id = String(message.toolCallId);
		if (file !== undefined && !savedOf.has(id)) results.push({ id, saved: file });
	}
	// What the decision rested on, so the profiler can compare it with what the next request cost (`profiler/clearing-ledger.ts`).
	const decided = costOf(clearedCandidates);
	const cacheRead = lastCacheRead(messages);
	api.appendEntry(CLEARED_RESULTS_TYPE, {
		results,
		oldTokens: Math.round(decided.oldTokens),
		suffixTokens: Math.round(decided.suffixTokensAfter),
		remainingRequests: Math.round(decided.remainingRequests * 10) / 10,
		prices: { ...prices, unit: catalogPrices(ctx.model, ttlMs ?? 0) ? "usd-per-million" : "ratio" },
		rewriteAnyway,
		...(cacheRead === undefined ? {} : { cacheRead }),
	});
	// The entry is in the branch now (`appendEntry` is synchronous), so `contextReads` sees the context as cleared.
	const shown = new Set(contextReads(ctx).map((read) => canonicalPath(read.file)));
	const calls = toolCallArguments(messages);
	for (const { candidate } of saved) {
		const args = calls.get(candidate.id);
		for (const file of args ? readPaths(candidate.tool, args, ctx.cwd) : [])
			if (!shown.has(canonicalPath(file))) guard.forget(file);
	}
}

/** `messages` with every result in `cleared` replaced by its placeholder; the same list when none is. */
export function applyClearedResults<T>(messages: T[], cleared: ReadonlyMap<string, string>): T[] {
	if (cleared.size === 0) return messages;
	return messages.map((message) => {
		if (!isRecord(message) || message.role !== "toolResult") return message;
		const saved = cleared.get(String(message.toolCallId));
		return saved === undefined ? message : { ...message, content: [{ type: "text", text: clearedPlaceholder(saved) }] };
	});
}
