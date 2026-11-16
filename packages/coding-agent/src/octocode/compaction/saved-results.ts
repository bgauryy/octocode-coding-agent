import { renderInstruction } from "../../core/prompt-template.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "../../core/session-manager.ts";
import { AGENT_RESULT_TYPE, JOB_TYPE } from "../shared/messages.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { clearedResults } from "../files/reads.ts";
import { shortPath } from "../../utils/display-path.ts";
import { sessionTempRoot } from "../shared/home.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { SAVED_RESULTS_LIST_LABEL } from "../shared/saved-files.ts";
import { saveFullOutput } from "../shared/spill.ts";
import { contentText } from "../shared/util.ts";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

/**
 * The files Octocode saved from the part of the conversation a summary replaces. A result bounded when written
 * (`capOutputToFile`: "Output trimmed … Full output: <path>"), a screenshot or image original, a fetched page, a bash log
 * and an old result cleared to save context (`clearing.ts`) each hold their whole text in the session's
 * `output/` or `bash/` folder and name that file only in the result itself. Compaction drops the result, so without
 * this the model would be told, in a result it no longer sees, that evidence was saved and never learn where.
 *
 * Like `<read-files>` and `<modified-files>`, the paths are appended to the summary's text by code, and kept in the
 * compaction's `details.savedResults` so the next summary carries them on. One source finds them: a path under the
 * sessions folder in a tool result's text or a finished background job's report, or the file a clearing entry recorded for a result.
 */

/** The compaction `details` key that carries the paths into the next summary. */
export const SAVED_RESULTS_DETAILS = "savedResults";

/**
 * The most characters of paths listed in the summary itself (about 750 tokens, some 25 paths): a longer list is written
 * whole to a file and the summary names that file, so a long session's summary does not refill the context it frees.
 */
export const SAVED_RESULTS_INLINE_CHARS = 3_000;

const OPEN = "<saved-results>";
const CLOSE = "</saved-results>";
/** A block as the model might write one anywhere in its text, with the blank lines before it. */
const ANY_BLOCK = /\n*<saved-results(?: count="\d+")?>\n[\s\S]*?\n<\/saved-results>/g;

/**
 * The model's summary without any `<saved-results>` block it wrote itself: code owns that block (it appends the one
 * list of saved files), so a second one from the model would duplicate it or contradict it.
 */
export function withoutModelSavedResults(summary: string): string {
	return summary.replace(ANY_BLOCK, "");
}

/**
 * Every spelling the notes give a saved file's path: absolute, relative to the working directory, or under `~`
 * (`shortPath`), then the folders `<session>/output|bash/<name>`.
 */
function savedPathPattern(root: string): RegExp {
	const prefixes = [...new Set([root, shortPath(root), homeTilde(root)])].sort((a, b) => b.length - a.length);
	const separator = "[\\\\/]";
	return new RegExp(
		`(?<![\\w.~/\\\\-])(?:${prefixes.map(escapeRegExp).join("|")})${separator}[\\w.-]+${separator}(?:output|bash)${separator}[\\w.-]*\\w`,
		"g",
	);
}

/** The absolute path a spelling of a saved file names, or undefined when it is not under the sessions folder. */
function resolveSaved(spelling: string, root: string): string | undefined {
	const file = spelling.startsWith("~") ? path.join(os.homedir(), spelling.slice(1)) : path.resolve(spelling);
	return file.startsWith(`${root}${path.sep}`) ? file : undefined;
}

/** The files in the sessions folder that `text` names, absolute, in order of appearance. */
function savedPaths(text: string): string[] {
	const root = sessionTempRoot();
	return [...text.matchAll(savedPathPattern(root))].flatMap((match) => resolveSaved(match[0], root) ?? []);
}

/**
 * The saved conversation of the subagent run `message` records (a finished `agent` result or a background report): its
 * transcript and its archive folder, so the parent can still open them once the report is summarized away.
 */
function childSessionPaths(message: Record<string, unknown>): string[] {
	const run =
		(message.role === "toolResult" && message.toolName === "agent") ||
		(message.role === "custom" && message.customType === AGENT_RESULT_TYPE);
	const session = run && isRecord(message.details) ? message.details.session : undefined;
	if (!isRecord(session)) return [];
	return [session.file, session.archive].filter((file): file is string => typeof file === "string");
}

/** The message a branch entry adds to the context, with a custom message's text and details kept (a job report names its log there, a subagent report its transcript). */
function branchMessage(entry: SessionEntry): unknown {
	if (entry.type === "message") return entry.message;
	return entry.type === "custom_message"
		? { role: "custom", customType: entry.customType, content: entry.content, details: entry.details }
		: undefined;
}

/**
 * The messages compaction `at` summarized: the entries from where the compaction before it began keeping (else right
 * after it) up to where it begins keeping (else up to it). Those it kept are summarized by the next one.
 */
function stretchMessages(
	branch: readonly SessionEntry[],
	at: number,
	before: number | undefined,
	indices: ReadonlyMap<string, number>,
): unknown[] {
	const indexOf = (id: unknown, fallback: number): number => {
		const index = typeof id === "string" ? (indices.get(id) ?? -1) : -1;
		return index >= 0 ? index : fallback;
	};
	const from =
		before === undefined
			? 0
			: Math.min(indexOf((branch[before] as { firstKeptEntryId?: unknown }).firstKeptEntryId, before + 1), at);
	const to = Math.min(indexOf((branch[at] as { firstKeptEntryId?: unknown }).firstKeptEntryId, at), at);
	return branch.slice(from, Math.max(from, to)).map(branchMessage);
}

/**
 * What earlier summaries carried under the `details` key: the list of the latest compaction on the branch that recorded
 * one, then the messages of each later stretch that a compaction without a record (Octocode's default summary, which has
 * no such details) summarized, oldest first, to be read as for an Octocode summary.
 */
export function carriedRecords(
	branch: readonly SessionEntry[],
	key: string,
): { recorded: unknown[]; stretches: unknown[][] } {
	const compactions: number[] = [];
	const indices = new Map<string, number>();
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		const { id } = entry;
		if (!indices.has(id)) indices.set(id, index);
		if (entry.type === "compaction") compactions.push(index);
	}
	const stretches: unknown[][] = [];
	for (let at = compactions.length - 1; at >= 0; at--) {
		const entry = branch[compactions[at]] as SessionEntry & { details?: unknown };
		const carried = isRecord(entry.details) ? entry.details[key] : undefined;
		if (Array.isArray(carried)) return { recorded: carried as unknown[], stretches: stretches.reverse() };
		stretches.push(stretchMessages(branch, compactions[at], compactions[at - 1], indices));
	}
	return { recorded: [], stretches: stretches.reverse() };
}

/** The paths earlier summaries carried (`carriedRecords`), and the files saved during each stretch without a record. */
export function carriedSavedResults(branch: readonly SessionEntry[]): string[] {
	const { recorded, stretches } = carriedRecords(branch, SAVED_RESULTS_DETAILS);
	const cleared = clearedResults(branch);
	return [
		...new Set([
			...recorded.filter((item): item is string => typeof item === "string"),
			...stretches.flatMap((messages) => savedResultPaths(messages, cleared)),
		]),
	];
}

/**
 * Each file saved from the summarized `messages`, once: those `carried` from the earlier summary that are still on disk
 * (the session sweep removes aged ones the latest summary no longer names), then a subagent run's saved conversation and the paths a tool result or job report
 * names, then the file `cleared` (tool call id → saved copy, `clearedResults`) holds for a result that was cleared.
 */
export function savedResultPaths(
	messages: readonly unknown[],
	cleared: ReadonlyMap<string, string>,
	carried: readonly string[] = [],
): string[] {
	const found = new Set(carried.filter((file) => fs.existsSync(file)));
	for (const message of messages) {
		if (!isRecord(message)) continue;
		for (const file of childSessionPaths(message)) if (fs.existsSync(file)) found.add(file);
		// A finished background job's report names its log (and the older part after a rotation) like a result does.
		if (message.role === "custom" && message.customType === JOB_TYPE)
			for (const file of savedPaths(contentText(message.content))) found.add(file);
		if (message.role !== "toolResult") continue;
		for (const file of savedPaths(contentText(message.content))) found.add(file);
		const copy = cleared.get(String(message.toolCallId));
		if (copy !== undefined) for (const file of savedPaths(copy)) found.add(file);
	}
	return [...found];
}

/**
 * The summary's block of saved files, empty when there are none: the paths listed one per line, or (over
 * `SAVED_RESULTS_INLINE_CHARS`) a pointer to a file in the session's output folder that lists them all. When that file
 * cannot be written the whole list stays in the summary.
 */
export function savedResultsBlock(files: readonly string[]): string {
	if (files.length === 0) return "";
	const lines = files.map((file) => shortPath(file));
	const list = lines.join("\n");
	const spilled =
		list.length > SAVED_RESULTS_INLINE_CHARS ? saveFullOutput(`${list}\n`, SAVED_RESULTS_LIST_LABEL) : undefined;
	if (spilled === undefined)
		return `\n\n${OPEN}\n${renderInstruction("notices/recovery/saved-results.md", { listed: "" })}\n${list}\n${CLOSE}`;
	const listed = renderInstruction("notices/recovery/file-list.md", { count: files.length, file: shortPath(spilled) });
	return `\n\n<saved-results count="${files.length}">\n${renderInstruction("notices/recovery/saved-results.md", { listed })}\n${CLOSE}`;
}
