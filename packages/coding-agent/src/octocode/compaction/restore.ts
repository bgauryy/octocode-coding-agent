import { renderPrompt } from "../../core/prompt-template.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { estimateProjectedContextTokens } from "../../core/compaction/index.ts";
import type { SetupPick, FeatureContext, SessionBeforeCompactEvent } from "../../core/features/index.ts";
import { firstGap, type LineRange, lineCount } from "../files/coverage.ts";
import { contextReads, RESTORED_FILES_TYPE, seenFiles, type WorkedFile } from "../files/reads.ts";
import type { FileGuard } from "../files/tool/guard.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { CompactionThinking } from "../../core/compaction/settings.ts";
import { covers, shownRanges } from "./restore-shown.ts";
import { type Outline, outlineOf } from "./restore-outline.ts";
import { restoreLimits, type RestoreLimits, RESTORE_TOTAL_CHARS } from "./restore-limits.ts";
import { limitsFor } from "./limits.ts";
import { autoCompactAt } from "../shared/tokens.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { cutText } from "@octocodeai/octocode-common/text";
import { RESTORE_MAX_BYTES, sameStamp, type Stamp, textOf } from "./restore-read.ts";

/**
 * After a compaction, the files the agent was working on are read again from disk and put back in its context: the summary names them, but editing one would otherwise need a fresh `read` first (the file guard
 * refuses a change to a file whose read left the context). The few most recently read or changed in the summarized
 * part come back, each within a per-file budget (a file over it shows its outline, the declarations with their line
 * numbers, not its text; one with no declaration shows the lines from where the agent last read or changed it, with a
 * note naming them), within a total budget sized to the window, and count as read once the message is in the model's context (Octocode holds a context-only message until the running turn
 * ends, so the guard records them when a model call first carries it, not when it is sent). A file the messages kept
 * after the summary already hold, as it is on disk now (`heldFiles`), is not read back.
 */

export * from "./restore-limits.ts";
/** A file that would get fewer characters than this is not read back: a stub counted as read helps no one. */
export const RESTORE_MIN_FILE_CHARS = 2_000;
/** At most this many candidates that cannot be read back (binary, too large, missing, not UTF-8) are tried: a run of them must not stall the compaction. */
export const RESTORE_MAX_SKIPPED = 20;

type Preparation = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages">;

/**
 * The files read or changed in the summarized messages, most recently worked on first, each with the line the agent
 * last read from or changed. A file read back by an earlier compaction ranks by the work it stands for, not by when it
 * was read back, so it does not keep coming back ahead of newer work.
 */
export function recentFiles(preparation: Preparation, cwd: string): WorkedFile[] {
	// The order and lines `restoreFiles` uses; `restore-picks.ts` marks the files only read.
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].map((message, index) => ({
		id: String(index),
		message,
	}));
	return [...seenFiles(messages, cwd).values()]
		.sort((a, b) => (b.workedAt ?? 0) - (a.workedAt ?? 0))
		.map(({ file, workedAt, line }) => ({
			file,
			...(workedAt === undefined ? {} : { workedAt }),
			...(line ? { line } : {}),
		}));
}

/** A path as an XML attribute value: a file name cannot close the attribute or the tag. */
const attribute = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Window {
	text: string;
	/** First and last line shown (1-based), and the file's line count. */
	first: number;
	last: number;
	total: number;
	cut: boolean;
	/** The text is the file's outline, not its lines. */
	outline?: Outline;
}

/**
 * Whole lines of `text` within `max` characters, starting at `line` (else the first line); a window that reaches the
 * end of the file with room left starts earlier. A start line longer than `max` alone is cut.
 */
function windowOf(text: string, max: number, line = 1): Window {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const total = lines.length;
	if (text.length <= max) return { text, first: 1, last: total, total, cut: false };
	const start = Math.min(Math.max(line, 1), total) - 1;
	let first = start;
	let last = start;
	let used = 0;
	while (last < total && used + lines[last].length <= max) used += lines[last++].length;
	if (last === start)
		return {
			text: cutText(lines[start], max, { chars: true }),
			first: start + 1,
			last: start + 1,
			total,
			cut: true,
		};
	while (last === total && first > 0 && used + lines[first - 1].length <= max) used += lines[--first].length;
	return { text: lines.slice(first, last).join(""), first: first + 1, last, total, cut: true };
}

/**
 * A file to read back: `onlyRead` when the summarized span read it without changing it (`restore-picks.ts`). Such a
 * file is named, not read back: most of them are never touched again after a compaction, and a read brings one back
 * when the work returns to it.
 */
export interface RestoreCandidate extends WorkedFile {
	onlyRead?: boolean;
}

interface Restored {
	/** The message body: each file in a `<file>` block, then the line naming the files only read (`listed`). */
	content: string;
	/** The files only read, as named (relative to the working directory, with the line last read). */
	listed: string[];
	/** `stamp`: the file's stat when it was read back (`settleRestoredFiles` checks it is unchanged). */
	files: Array<{ file: string; whole: boolean; sha256?: string; size?: number; stamp: Stamp }>;
	/** The work each restored file stands for, so the next compaction ranks it by that (`seenFiles`). */
	worked: WorkedFile[];
}

/**
 * The files (canonical paths) the context holds in full as they are on disk now: shown whole, or by reads whose line
 * ranges together cover every line, by a result not older than the file's last change (`FileGuard.restore`'s rule). A
 * file shown only in part, with a stale view, or by a cleared result is not held, nor one over `RESTORE_MAX_BYTES`.
 */
export function heldFiles(
	reads: ReadonlyArray<{ file: string; at: number; partial?: boolean; lines?: readonly LineRange[] }>,
): Set<string> {
	const held = new Set<string>();
	for (const { file, at, partial, lines } of reads) {
		const real = canonicalPath(file);
		try {
			const stat = fs.statSync(real);
			// A file over the size restore reads back is never restored, so whether the context holds it does not matter: no read for it.
			if (!stat.isFile() || stat.size > RESTORE_MAX_BYTES || Math.max(stat.mtimeMs, stat.ctimeMs) > at) continue;
			if (partial && (!lines || firstGap(lines, lineCount(fs.readFileSync(real))) !== undefined)) continue;
			held.add(real);
		} catch {
			// A file that cannot be read now is not held in any useful sense: restoring it fails the same way and is skipped.
		}
	}
	return held;
}

/**
 * Reads back up to `limits.maxFiles` of `candidates` (most recent first) except those in `held` (`heldFiles`: the
 * context has their current content), within the budgets, and gives up after `RESTORE_MAX_SKIPPED` candidates that
 * cannot be read back. A cut window of a file that `shown` (`shownRanges`) already covers is not read back either.
 * A candidate marked `onlyRead` is only named, up to `limits.maxFiles` of them, in one line after the files. Undefined
 * when nothing qualifies.
 */
export function restoreFiles(
	candidates: readonly RestoreCandidate[],
	held: ReadonlySet<string>,
	cwd: string,
	total = RESTORE_TOTAL_CHARS,
	limits: RestoreLimits = restoreLimits(),
	shown: ReadonlyMap<string, readonly LineRange[]> = new Map(),
): Restored | undefined {
	const blocks: string[] = [];
	const files: Restored["files"] = [];
	const worked: WorkedFile[] = [];
	const listed: string[] = [];
	const intro = renderPrompt("notices/compaction/restored-files.md");
	let used = intro.length + 2;
	let skipped = 0;
	// One file read by two paths (a symlink and its target) comes back once.
	const taken = new Set<string>();
	let full = false;
	const shownAs = (file: string) => {
		const relative = path.relative(cwd, file);
		return relative.startsWith("..") ? file : relative;
	};
	for (const candidate of candidates) {
		const { file } = candidate;
		const real = canonicalPath(file);
		if (candidate.onlyRead) {
			if (listed.length < limits.maxFiles && !held.has(real) && !taken.has(real)) {
				taken.add(real);
				listed.push(`${shownAs(file)}${candidate.line ? `:${candidate.line}` : ""}`);
			}
			continue;
		}
		// Past the budgets no other file is read back; the files only read are still named.
		if (full) continue;
		const separator = blocks.length > 0 ? 2 : 0;
		const available = total - used - separator;
		let room = Math.min(limits.fileChars, available);
		if (files.length >= limits.maxFiles || room < RESTORE_MIN_FILE_CHARS || skipped >= RESTORE_MAX_SKIPPED) {
			full = true;
			continue;
		}
		if (held.has(real) || taken.has(real)) continue;
		const read = textOf(file);
		if (read === undefined) {
			skipped++;
			continue;
		}
		const { text } = read;
		// A file over the whole-file size shows its outline when it has declarations, else a window of whole lines.
		const viewOf = (chars: number): Window => {
			const outline =
				text.length > limits.fileChars
					? outlineOf(text, Math.min(chars, limits.outlineChars), candidate.line)
					: undefined;
			if (!outline) return windowOf(text, chars, candidate.line);
			const lines = text.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
			return { text: outline.text, first: 1, last: lines, total: lines, cut: true, outline };
		};
		let view = viewOf(room);
		if (view.text.length === 0 && text.length > 0) {
			skipped++;
			continue;
		}
		const display = shownAs(file);
		const render = (window: Window): string => {
			const note = window.outline
				? `\n${renderPrompt("notices/compaction/restored-outline.md", {
						shown: window.outline.shown,
						count: window.outline.count,
						total: window.total,
						fromLast: window.outline.marked,
					})}`
				: window.cut
					? `\n${renderPrompt("notices/compaction/restored-cut.md", {
							first: window.first,
							last: window.last,
							total: window.total,
							fromLast: Boolean(candidate.line) && window.first > 1,
						})}`
					: "";
			// The file's text stays exact; a file that itself contains `</file>` gets a tag it cannot close by accident.
			const tag = window.text.includes("</file") ? `file-${sha256(text).slice(0, 8)}` : "file";
			return `<${tag} path="${attribute(display)}">\n${window.text}${window.text.endsWith("\n") || window.text === "" ? "" : "\n"}</${tag}>${note}`;
		};
		let block = render(view);
		// Include framing and truncation notes in the budget, without dropping every file when the text fills it.
		while (block.length > available && room >= RESTORE_MIN_FILE_CHARS) {
			room -= block.length - available;
			if (room < RESTORE_MIN_FILE_CHARS) break;
			view = viewOf(room);
			block = render(view);
		}
		if (room < RESTORE_MIN_FILE_CHARS || block.length > available) {
			full = true;
			continue;
		}
		// The tail's reads show every line of this window: the same text would come twice.
		if (view.cut && !view.outline && covers(shown.get(real), view.first, view.last)) continue;
		taken.add(real);
		blocks.push(block);
		files.push(
			view.cut
				? { file, whole: false, stamp: read.stamp }
				: { file, whole: true, sha256: sha256(text), size: Buffer.byteLength(text), stamp: read.stamp },
		);
		const { onlyRead: _onlyRead, ...work } = candidate;
		worked.push(work);
		used += separator + block.length;
	}
	const list =
		listed.length > 0
			? renderPrompt("notices/compaction/restored-read-list.md", {
					alone: files.length === 0,
					files: listed.join(", "),
				})
			: undefined;
	const named = list !== undefined && (files.length === 0 ? list.length : used + 2 + list.length) <= total;
	if (files.length === 0) return named ? { content: list, listed, files, worked } : undefined;
	const content = `${intro}\n\n${blocks.join("\n\n")}${named ? `\n\n${list}` : ""}`;
	return { content, listed: named ? listed : [], files, worked };
}

/** Files sent back to the context, recorded in the guard once a model call carries the message (`settleRestoredFiles`). */
export interface PendingRestore {
	id: string;
	files: Restored["files"];
}

/**
 * Puts `pending` (from `recentFiles`, taken before the compaction, minus `contextHeld`: the project context files the system prompt shows, `recordContextFiles`) back into the context right after it, as a hidden
 * message, within `total` characters. Run it after the guard was rebuilt from the compacted context; returns what to
 * record once the message is delivered.
 */
export async function deliverRestoredFiles(
	api: SetupPick<"session", "sendMessage"> & SetupPick<"settings", "get">,
	pending: readonly WorkedFile[],
	ctx: Pick<FeatureContext, "cwd" | "sessionManager"> & Partial<Pick<FeatureContext, "model">>,
	budget: number,
	thinking?: CompactionThinking,
	contextHeld: ReadonlySet<string> = new Set(),
): Promise<PendingRestore | undefined> {
	let total = budget;
	if (ctx.model && Number.isFinite(ctx.model.contextWindow) && ctx.model.contextWindow > 0) {
		const tokens = estimateProjectedContextTokens(
			ctx.sessionManager.buildSessionProjection(),
			ctx.sessionManager.getBranch(),
		).tokens;
		// The trigger the session compacts at (`limits.compaction`), as every other caller reads it.
		const remaining =
			autoCompactAt(ctx.model, thinking, limitsFor({ settings: api.settings }, ctx.model).compaction) - tokens;
		total = Math.min(total, Math.max(0, Math.floor(remaining * CHARS_PER_TOKEN)));
	}
	const reads = contextReads(ctx);
	const restored = restoreFiles(
		pending,
		new Set([...heldFiles(reads), ...contextHeld]),
		ctx.cwd,
		total,
		restoreLimits(ctx.model?.contextWindow),
		shownRanges(reads, RESTORE_MAX_BYTES),
	);
	if (!restored || restored.content.length > total) return undefined;
	// Partial excerpts stay partial for the guard, but an identical retained excerpt need not be appended again.
	const retained = ctx.sessionManager
		.buildSessionProjection()
		.entries.flatMap((entry) => entry.messages)
		.find(
			(message) =>
				message.role === "custom" &&
				message.customType === RESTORED_FILES_TYPE &&
				message.content === restored.content &&
				isRecord(message.details) &&
				typeof message.details.id === "string" &&
				Array.isArray(message.details.files) &&
				message.details.files.length === restored.files.length &&
				message.details.files.every((file, index) => file === restored.files[index].file),
		);
	if (retained?.role === "custom" && isRecord(retained.details) && typeof retained.details.id === "string")
		return { id: retained.details.id, files: restored.files };
	const id = randomUUID();
	try {
		const partial = restored.files.filter((entry) => !entry.whole).map((entry) => entry.file);
		const details = {
			id,
			files: restored.files.map((entry) => entry.file),
			...(partial.length > 0 ? { partial } : {}),
			...(restored.listed.length > 0 ? { listed: restored.listed } : {}),
			worked: restored.worked,
		};
		await api.session.sendMessage(
			{ customType: RESTORED_FILES_TYPE, content: restored.content, display: false, details },
			{ triggerTurn: false },
		);
	} catch (error) {
		// Octocode's ctx and api throw this once the session was replaced; any other failure is a real error and goes on.
		if (isStaleSessionError(error)) return undefined;
		throw error;
	}
	return { id, files: restored.files };
}

/**
 * Records `pending`'s files in the guard when `messages` (a model call's) carry its message; true when they did. A file
 * that changed on disk since it was read back is recorded stale: the model holds the old text, so a write or delete
 * needs a fresh read.
 */
export function settleRestoredFiles(messages: readonly unknown[], pending: PendingRestore, guard: FileGuard): boolean {
	const carried = messages.some(
		(message) =>
			isRecord(message) &&
			message.role === "custom" &&
			message.customType === RESTORED_FILES_TYPE &&
			isRecord(message.details) &&
			message.details.id === pending.id,
	);
	if (!carried) return false;
	for (const entry of pending.files) {
		const known =
			entry.whole && entry.sha256 !== undefined && entry.size !== undefined
				? { sha256: entry.sha256, size: entry.size }
				: undefined;
		const unchanged = sameStamp(entry.file, entry.stamp);
		guard.record(entry.file, unchanged ? known : undefined, !entry.whole);
		if (!unchanged) guard.stale(entry.file);
	}
	return true;
}
