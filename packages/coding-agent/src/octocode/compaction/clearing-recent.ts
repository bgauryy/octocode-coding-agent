import type { MessageRef } from "../files/reads.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { Candidate } from "./clearing-candidates.ts";

/**
 * Which old results are still in use, so clearing keeps them beyond the newest `KEEP_RECENT_RESULTS`: the call came
 * within the last `KEEP_RECENT_TURNS` assistant turns, or a message of those turns names a path the call read (in its
 * text, thinking or tool-call arguments). A count alone cleared a result a few turns after it was read when each turn
 * made one call, which forced re-reads that cost more than the clearing saved. The kept results are bounded by size
 * (`KEEP_IN_USE_TOKENS`, newest first), so a clearing that triggers still frees the rest.
 */

/** Assistant turns within which a result's call, or a mention of its path, keeps it. */
export const KEEP_RECENT_TURNS = 10;
/**
 * The most text, in tokens (by `CHARS_PER_TOKEN`), the results in use keep beyond the newest ones; older ones past it
 * are cleared as before. Equal to the warm clearing floor (`CLEAR_AT_LEAST_TOKENS`): holding back more than one warm
 * clearing frees would keep re-sending what the clearing is for.
 */
export const KEEP_IN_USE_TOKENS = 20_000;

/** The `path` strings anywhere in a call's arguments (`read`, `file` and Octocode query arrays all spell it so). */
function pathArgs(value: unknown, into: string[] = []): string[] {
	if (Array.isArray(value)) for (const each of value) pathArgs(each, into);
	else if (isRecord(value))
		for (const [key, each] of Object.entries(value)) {
			if (key === "path" && typeof each === "string") into.push(each);
			else if (typeof each === "object") pathArgs(each, into);
		}
	return into;
}

/**
 * How a path is recognized in later text: its last two segments, so an absolute path and a relative one match. A key
 * with neither a separator nor an extension (`.`, `src`) would match nearly any text and is skipped.
 */
function mentionKey(file: string): string | undefined {
	const key = file
		.split(/[\\/]+/)
		.filter(Boolean)
		.slice(-2)
		.join("/");
	return /[/]|[^.]\.[^.]/.test(key) ? key : undefined;
}

/** The text of the assistant messages from `start` on, joined: what the recent turns said and called. */
function recentText(messages: readonly MessageRef[], start: number): string {
	const parts: string[] = [];
	for (let index = start; index < messages.length; index++) {
		const message = messages[index].message;
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part)) continue;
			if (typeof part.text === "string") parts.push(part.text);
			else if (typeof part.thinking === "string") parts.push(part.thinking);
			else if (part.type === "toolCall") parts.push(JSON.stringify(part.arguments ?? null));
		}
	}
	return parts.join("\n");
}

/**
 * The ids of `candidates` (oldest first) in recent use (see above), newest first until `KEEP_IN_USE_TOKENS`. One pass
 * over the messages finds where the window starts; its text is joined once, and only for candidates older than it.
 */
export function inRecentUse(
	candidates: readonly Candidate[],
	messages: readonly MessageRef[],
	calls: ReadonlyMap<string, Record<string, unknown>>,
): Set<string> {
	let start = 0;
	for (let index = messages.length - 1, turns = 0; index >= 0; index--) {
		const message = messages[index].message;
		if (isRecord(message) && message.role === "assistant" && ++turns === KEEP_RECENT_TURNS) {
			start = index;
			break;
		}
	}
	const inUse = new Set<string>();
	let room = KEEP_IN_USE_TOKENS * CHARS_PER_TOKEN;
	let text: string | undefined;
	const used = (candidate: Candidate): boolean => {
		// A result follows its call's assistant message, and an input is that message: either way the index is in the window.
		if (candidate.index >= start) return true;
		const keys = pathArgs(calls.get(candidate.id)).flatMap((file) => mentionKey(file) ?? []);
		if (keys.length === 0) return false;
		text ??= recentText(messages, start);
		const said = text;
		return keys.some((key) => said.includes(key));
	};
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidate = candidates[index];
		if (!used(candidate)) continue;
		if (candidate.text.length > room) break;
		room -= candidate.text.length;
		inUse.add(candidate.id);
	}
	return inUse;
}
