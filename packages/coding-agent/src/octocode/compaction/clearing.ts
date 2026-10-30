import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
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
import { canonicalPath } from "../shared/home/repo.ts";
import { CHARS_PER_TOKEN, estimateTokens } from "../../core/compaction/tokens.ts";
import { isRecord } from "../../utils/guards.ts";
import { shortPath } from "../shared/format.ts";
import { readPaths } from "../shared/home.ts";
import { isOctocodeTool } from "../../../../mcp/src/presets/octocode/names.ts";
import { saveContentCopy } from "../shared/spill.ts";
import { cacheClock } from "./cache.ts";

/**
 * Clearing old tool results after the prompt cache went cold (the practice of Claude Code's time-based clearing).
 *
 * Clearing a result while the cache is warm makes the next request rewrite the whole cache entry. After an idle gap
 * longer than the entry's lifetime the next request rewrites it anyway, so clearing then costs nothing and shrinks every
 * later request. So before a request, whether it starts a run or follows a long tool inside one, when the cache was
 * last used (the last reply, or a refresh by Octocode's warmer) longer ago than its lifetime, the old results of tools whose
 * output can be fetched again are replaced by a placeholder, keeping the newest `KEEP_RECENT_RESULTS`, and only when
 * that frees at least `CLEAR_AT_LEAST_TOKENS`. Once the request is made the cache is warm again, so the same check
 * clears nothing more until the next gap. A repeated-read note (`files/dedupe`) that points at a cleared
 * result gets the same placeholder, so it never points "above" at text that is gone.
 *
 * Nothing is lost: each result's whole text is saved first and the placeholder names the file (a `bash` result already
 * has one: Octocode's spill file of the command's whole output); a result that cannot be saved stays. The decision is a session entry (`CLEARED_RESULTS_TYPE`) that every request applies the same way
 * (`applyClearedResults`), so the prompt stays byte-stable between requests and survives a resume, reload or fork.
 */

/** The newest clearable results always kept: the next step usually builds on the last few calls, and older ones come back by repeating the call or reading the saved file. */
export const KEEP_RECENT_RESULTS = 5;
/** The text the older results must total (in tokens, by `CHARS_PER_TOKEN`) for any clearing to happen: below it the saving is too small to be worth a changed prefix and the saved copies. */
export const CLEAR_AT_LEAST_TOKENS = 20_000;

/**
 * Octocode's read-only tools and `web` (and every Octocode MCP tool, `isOctocodeTool`): a result is fetched again by repeating
 * the call. Never `file` or `agent`; `bash` only for a read-only command whose output was spilled to a file (`spilledBash`).
 * `read`, `grep`, `find` and `ls` are no longer Octocode tools; they stay for resumed transcripts of other hosts that
 * hold their results, and for custom tools that still use those names.
 */
const CLEARABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "web"]);

const PLACEHOLDER_START = "[Old tool result cleared";

/** What stands for a cleared result; `saved` is where `saveContentCopy` put its whole text. */
function clearedPlaceholder(saved: string): string {
	return `${PLACEHOLDER_START} after the prompt cache expired. Full output: ${saved}. Read that file, or run the call again.]`;
}

interface Candidate {
	id: string;
	tool: string;
	text: string;
	/** Where the whole text is saved already (a `bash` result's spill file); otherwise it is saved when cleared. */
	saved?: string;
}

/** The repeated-read note behind a result (`details.unchangedOf`: the call it points at), if it is one. */
function noteOf(message: Record<string, unknown>): string | undefined {
	const unchangedOf = isRecord(message.details) ? message.details.unchangedOf : undefined;
	return typeof unchangedOf === "string" ? unchangedOf : undefined;
}

/**
 * The file holding the whole output of a `bash` result, when the result may be cleared: its command is read-only
 * (`readOnlyCommand`, so repeating it is harmless) and Octocode spilled its output to a file that still exists. A result
 * with no saved file keeps its text: clearing it would drop the only copy.
 */
function spilledBash(
	message: Record<string, unknown>,
	calls: ReadonlyMap<string, Record<string, unknown>>,
): string | undefined {
	const command = calls.get(String(message.toolCallId))?.command;
	const spilled = isRecord(message.details) ? message.details.fullOutputPath : undefined;
	return typeof command === "string" &&
		readOnlyCommand(command) &&
		typeof spilled === "string" &&
		fs.existsSync(spilled)
		? shortPath(spilled)
		: undefined;
}

/** Successful results of clearable tools that show only text and are not placeholders or repeated-read notes, oldest first. */
function clearableResults(messages: readonly MessageRef[]): Candidate[] {
	const calls = toolCallArguments(messages);
	return messages.flatMap(({ message }) => {
		if (
			!isRecord(message) ||
			message.role !== "toolResult" ||
			message.isError === true ||
			typeof message.toolCallId !== "string" ||
			noteOf(message) !== undefined
		)
			return [];
		const tool = String(message.toolName);
		const saved = tool === "bash" ? spilledBash(message, calls) : undefined;
		const text =
			CLEARABLE_TOOLS.has(tool) || isOctocodeTool(tool) || saved !== undefined ? plainText(message.content) : undefined;
		return text !== undefined && !text.startsWith(PLACEHOLDER_START)
			? [{ id: message.toolCallId, tool, text, ...(saved === undefined ? {} : { saved }) }]
			: [];
	});
}

/** The results to clear: all but the newest `KEEP_RECENT_RESULTS` not yet cleared, if they total `CLEAR_AT_LEAST_TOKENS`. */
function olderResults(candidates: readonly Candidate[], cleared: ReadonlyMap<string, string>): Candidate[] {
	const open = candidates.filter((candidate) => !cleared.has(candidate.id));
	const older = open.slice(0, Math.max(open.length - KEEP_RECENT_RESULTS, 0));
	return older.reduce((chars, candidate) => chars + candidate.text.length, 0) / CHARS_PER_TOKEN >= CLEAR_AT_LEAST_TOKENS
		? older
		: [];
}

/**
 * Share of the working context past which a request that rewrites the prefix anyway (a system update, a model switch,
 * a cold cache) clears old results first: the rewrite is paid regardless, so the clearing costs nothing extra, and the
 * smaller history is read back cheaper on every request that follows.
 */
const CLEAR_ABOVE_CONTEXT_SHARE = 0.5;

/**
 * Whether the request about to be made rewrites the history's cache entry anyway: its last message is a system update
 * (a section patch or tool change recorded after the leading system message), or the model is not the one that
 * answered last (a model switch).
 */
export function prefixRewritten(messages: readonly unknown[], model: { provider?: string; id?: string } | undefined) {
	const last = messages.at(-1);
	const firstSystem = messages.findIndex((message) => isRecord(message) && message.role === "system");
	if (isRecord(last) && last.role === "system" && firstSystem >= 0 && firstSystem !== messages.length - 1) return true;
	if (!model?.provider || !model.id) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		if (typeof message.provider !== "string" || typeof message.model !== "string") return false;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
}

/** What else, besides a cold cache, lets a request clear old results: see `clearStaleResults`. */
export interface ClearingOccasion {
	/** The request rewrites the prefix anyway (`prefixRewritten`). */
	rewrite?: boolean;
	/** The working context in tokens (the model's window after the session's context budget). */
	contextWindow?: number;
}

/**
 * Clears the old results when the cache lifetime `ttlMs` has passed since the cache was last used (`now`), or when the
 * request rewrites the prefix anyway (`occasion.rewrite`) and the context is past `CLEAR_ABOVE_CONTEXT_SHARE` of its
 * window: saves each, records the decision with `api.appendEntry`, and makes the file guard forget the files whose read
 * was cleared and that no read left in the context still shows (the rule `contextReads` rebuilds the guard by on a
 * resume). Does nothing when neither applies, the session has no reply yet, or less than `CLEAR_AT_LEAST_TOKENS` would
 * be freed.
 */
export function clearStaleResults(
	api: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	guard: Pick<FileGuard, "forget">,
	ttlMs: number | undefined,
	occasion: ClearingOccasion = {},
	now = Date.now(),
): void {
	const lastUse = cacheClock(ctx.sessionManager).useAt;
	if (lastUse === undefined) return;
	const cold = ttlMs !== undefined && now - lastUse > ttlMs;
	const messages = contextMessages(ctx);
	const crowded =
		occasion.rewrite === true &&
		occasion.contextWindow !== undefined &&
		messages.reduce((sum, { message }) => sum + estimateTokens(message as never), 0) >
			occasion.contextWindow * CLEAR_ABOVE_CONTEXT_SHARE;
	if (!cold && !crowded) return;
	const older = olderResults(clearableResults(messages), sessionCleared(ctx.sessionManager));
	if (older.length === 0) return;
	const saved = older.flatMap((candidate) => {
		const file = candidate.saved ?? saveContentCopy(candidate.text, `cleared-${candidate.tool}`);
		return file ? [{ candidate, file }] : [];
	});
	// Results that could not be saved stay; too few left to matter leaves the saved copies unused.
	if (
		saved.reduce((chars, { candidate }) => chars + candidate.text.length, 0) / CHARS_PER_TOKEN <
		CLEAR_AT_LEAST_TOKENS
	)
		return;
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
	api.appendEntry(CLEARED_RESULTS_TYPE, { results });
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
