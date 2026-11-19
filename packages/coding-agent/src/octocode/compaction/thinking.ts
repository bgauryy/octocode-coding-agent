// Request projection, not compaction-only: `requestMessages` runs on every request (see README.md).
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { fenceUntrustedResults } from "./untrusted-results.ts";
import { applyClearedResults } from "./clearing.ts";

/**
 * Thinking that a summary or a cleared result made stale (Anthropic's preserved thinking).
 *
 * Newer Claude models bind each thinking block to the exact prefix it was produced after: system prompt, tools and every
 * earlier message. A compaction Octocode writes on the client puts a summary in front of the turns it keeps, and clearing
 * a cold result (`clearing.ts`) replaces a message that every later turn was produced after, so the thinking in those
 * turns no longer matches its prefix. octocode-ai asks the API to drop such a block instead of failing
 * (`prefix_mismatch_behavior: "drop_block"`), so every request until the next compaction carried the same dead blocks and
 * Octocode showed "Anthropic dropped N thinking blocks". Anthropic's fix for keep-tail compaction with a summary written on
 * the client: strip the thinking from the kept turns. Removing thinking is valid (earlier thinking is not part of any
 * later block's prefix), and the model sees what it saw before, since the API dropped those blocks anyway.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */

/** Messages Octocode builds from a summary: every one sits before the turns it was written after. */
const SUMMARY_ROLES: ReadonlySet<string> = new Set(["compactionSummary", "branchSummary"]);

/** Whether `model` binds thinking to its prefix: the models octocode-ai sends `drop_block` for (`compat.supportsMidConvoEffort`). */
export function bindsThinkingToPrefix(model: unknown): boolean {
	return isRecord(model) && isRecord(model.compat) && model.compat.supportsMidConvoEffort === true;
}

/**
 * `messages` without the thinking of each assistant turn older than a summary placed before it; the rest of each turn,
 * and every other message, unchanged. The same list when there is none. By timestamps only, so every request (and the
 * cache-shared summary replaying it) strips the same blocks, across resume, reload and fork.
 */
export function stripStaleThinking<T>(messages: T[]): T[] {
	let summaryAt = Number.NEGATIVE_INFINITY;
	return stripThinkingOlderThan(messages, (message, at) => {
		if (SUMMARY_ROLES.has(String(message.role)) && at !== undefined) summaryAt = Math.max(summaryAt, at);
		return summaryAt;
	});
}

/**
 * `messages` without the thinking of each assistant turn that follows a cleared result and was produced before that
 * result was cleared (`clearedAt`, from `files/reads`): its prefix held the result's text, the request holds the
 * placeholder. Turns produced after the clearing were bound to the placeholder and keep their thinking. The same list
 * when nothing was cleared.
 */
export function stripThinkingBeforeClearing<T>(messages: T[], clearedAt: ReadonlyMap<string, number>): T[] {
	if (clearedAt.size === 0) return messages;
	let clearedBefore = Number.NEGATIVE_INFINITY;
	return stripThinkingOlderThan(messages, (message) => {
		if (message.role === "toolResult") {
			const at = clearedAt.get(String(message.toolCallId));
			if (at !== undefined) clearedBefore = Math.max(clearedBefore, at);
		}
		return clearedBefore;
	});
}

/**
 * The messages with thinking removed from each assistant turn stamped before `deadBefore(message, at)`, the moment
 * (so far in the walk) that its prefix changed; a turn with no timestamp, or stamped at that moment, keeps its thinking.
 */
function stripThinkingOlderThan<T>(
	messages: T[],
	deadBefore: (message: Record<string, unknown>, at: number | undefined) => number,
): T[] {
	let changed = false;
	const out = messages.map((message) => {
		if (!isRecord(message)) return message;
		const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
		const limit = deadBefore(message, at);
		if (message.role !== "assistant" || at === undefined || at >= limit || !Array.isArray(message.content))
			return message;
		const content = message.content.filter((part) => !(isRecord(part) && part.type === "thinking"));
		if (content.length === message.content.length) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? out : messages;
}

/**
 * What Octocode's `context` handler changes in every request to `model`: web and MCP results inside a fence that marks them as
 * data (`fenceUntrustedResults`), the results in `cleared` (the session branch's, `sessionCleared`) as their placeholders, and
 * no stale thinking: none a summary made stale, none a clearing (`clearedAt`, `sessionClearedAt`) made stale. The
 * cache-shared summary replays it, so its prefix is the one the cache holds. The same list when nothing changes.
 */
export function requestMessages<T>(
	messages: T[],
	model: unknown,
	cleared: ReadonlyMap<string, string>,
	clearedAt: ReadonlyMap<string, number> = new Map(),
): T[] {
	const replaced = applyClearedResults(fenceUntrustedResults(messages, cleared), cleared);
	return bindsThinkingToPrefix(model) ? stripThinkingBeforeClearing(stripStaleThinking(replaced), clearedAt) : replaced;
}
