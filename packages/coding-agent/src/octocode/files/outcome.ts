import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { plural } from "../../../../common/src/clip.ts";
import type { BashToolDetails } from "../../core/tools/index.ts";
import { formatDuration } from "../../utils/duration.ts";
import type { VerificationReceipt } from "./bash-jobs/types.ts";

/** What the files tools' results say, read without any terminal code, for every surface's display. */

/** What a bash result keeps: Octocode's truncation fields and the background job. */
export interface BashDetails extends BashToolDetails {
	verification?: VerificationReceipt;
	job?: string;
	pid?: number;
	log?: string;
	/** A foreground command that reached its deadline and went on as this job. */
	moved?: boolean;
}

const BASH_STATUS =
	/^Command (?:exited with code (-?\d+)|timed out after (\d+) seconds|aborted|(terminated without an exit code))\.?$/;
const TRUNCATION_NOTICE = /^\[Showing .*Full output: .+\]$/;
/** How the bash tool's hint after a timeout starts; the renderer drops it from the output lines. */
export const RERUN_HINT = "If it needs longer, rerun it";

/** A line Octocode or the bash tool added around the output (status, truncation notice, rerun hint), not command output. */
function noticeLine(trimmed: string): boolean {
	return BASH_STATUS.test(trimmed) || TRUNCATION_NOTICE.test(trimmed) || trimmed.startsWith(RERUN_HINT);
}

const LINE_BREAK = /\r\n?|\n|[\u2028\u2029]/g;

/**
 * Where the last `keep` output lines start: the cut a collapsed preview needs, so a streaming update sanitizes and
 * splits only its tail. Returns 0 when the part before the cut is blank (it would be trimmed, not counted).
 */
function tailCut(text: string, keep: number, structured = false): number {
	let end = text.length;
	let kept = 0;
	while (end > 0 && kept < keep) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		for (const line of sanitizeTerminalText(text.slice(start, end)).split("\n")) {
			const trimmed = line.trim();
			if (trimmed && (structured || !noticeLine(trimmed))) kept += 1;
		}
		end = start === 0 ? 0 : start - 1;
		if (kept >= keep) return /\S/.test(text.slice(0, start)) ? start : 0;
	}
	return 0;
}

/**
 * The `⎿` summary and body of a bash result: `exit 0 · 12 lines`, `exit 1 · 3 lines` (drawn as an error),
 * `timed out after 2m`. Octocode's status and truncation notices move into the summary; the body is the command output.
 * With `keep` (a collapsed preview), the body is only the tail holding the last `keep` output lines and `lines` counts
 * the whole body.
 */
export function bashOutcome(
	output: string,
	isError: boolean,
	running = false,
	keep?: number,
	facts?: BashToolDetails,
): { summary: string; body: string; lines?: number; spill?: string } {
	const structured = typeof facts?.output === "string";
	const text = structured ? facts.output! : output;
	let status =
		facts?.termination === "timeout"
			? `timed out after ${formatDuration((facts.timeoutSeconds ?? 0) * 1000)}`
			: facts?.termination === "aborted"
				? "aborted"
				: facts?.termination === "terminated"
					? "terminated (no exit code)"
					: facts?.exitCode !== undefined && facts.exitCode !== null
						? `exit ${facts.exitCode}`
						: undefined;
	let total = facts?.truncation?.totalLines;
	let spill = facts?.fullOutputPath;
	// An error's message is its first line, so only a status-bearing result is read from its tail.
	const cut = keep !== undefined && (!isError || structured) ? tailCut(text, keep, structured) : 0;
	const head = text.slice(0, cut);
	// Lines before the cut, less the leading blank ones the body trims (`tailCut` keeps a cut only after output).
	const headLines =
		cut === 0 ? 0 : (head.match(LINE_BREAK)?.length ?? 0) - (/^\s*/.exec(head)![0].match(LINE_BREAK)?.length ?? 0);
	const body: string[] = [];
	for (const line of sanitizeTerminalText(cut === 0 ? text : text.slice(cut)).split("\n")) {
		const trimmed = line.trim();
		// Old session entries predate structured Bash facts; parse their host notices only.
		const match = structured ? null : BASH_STATUS.exec(trimmed);
		if (match) {
			status =
				match[1] !== undefined
					? `exit ${match[1]}`
					: match[2] !== undefined
						? `timed out after ${formatDuration(Number(match[2]) * 1000)}`
						: match[3] !== undefined
							? "terminated (no exit code)"
							: "aborted";
			continue;
		}
		if (!structured && TRUNCATION_NOTICE.test(trimmed)) {
			const of = /\bof (\d+)\b/.exec(trimmed);
			if (of) total = Number(of[1]);
			spill = /Full output: (.+?)\]$/.exec(trimmed)?.[1];
			continue;
		}
		if (!structured && trimmed.startsWith(RERUN_HINT)) continue;
		body.push(line);
	}
	while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
	while (cut === 0 && body.length > 0 && body[0].trim() === "") body.shift();
	if (!structured && body.length === 1 && body[0] === "(no output)") body.length = 0;
	if (isError && !status) {
		// Not a command status (a missing directory, a refused command): the message is the summary.
		return { summary: body.shift() ?? "failed", body: body.join("\n"), ...(spill ? { spill } : {}) };
	}
	const lines = headLines + body.length;
	const count = total ?? lines;
	const size = count === 0 ? "no output" : plural(count, "line");
	return {
		summary: running ? `running · ${size}` : `${status ?? "exit 0"} · ${size}`,
		body: body.join("\n"),
		...(cut > 0 ? { lines } : {}),
		...(spill ? { spill } : {}),
	};
}

export interface QueryOutcome {
	type: "edit" | "write" | "delete";
	path: string;
	reason: string;
	ok: boolean;
	message: string;
	diff?: string;
	/** An applied edit: the change in the file's line count. */
	lineDelta?: number;
	/** The new content's digest, when the agent knows the whole file: a following anchored edit names it. */
	sourceSha256?: string;
	/** A filesystem commit, even if a later step made this query fail. */
	receipt?: MutationReceipt;
}

export interface MutationReceipt {
	canonicalPath: string;
	toolCallId: string;
	operation: "edit" | "write" | "delete";
	digest: string | null;
	/** Digest of bytes this query checked before committing, null for new files. */
	beforeDigest: string | null;
	sessionId: string;
	epoch: string;
	revision: number;
}

/** Size hint for a query in the call line: how many replacements, or how long the new content is. */
export function querySize(query: { type?: string; edits?: unknown[]; content?: string } | undefined): string {
	if (query?.type === "edit" && Array.isArray(query.edits) && query.edits.length > 0)
		return ` · ${plural(query.edits.length, "edit")}`;
	if (query?.type === "write" && typeof query.content === "string") {
		// A final newline ends the last line rather than starting another, as editors and `wc -l` count.
		const content = query.content.endsWith("\n") ? query.content.slice(0, -1) : query.content;
		return ` · ${plural(content === "" ? 0 : content.split("\n").length, "line")}`;
	}
	return "";
}

/** Added and removed line counts of a Octocode diff (lines prefixed with + / -, not the file headers). */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+(?!\+\+ )/.test(line)) added++;
		else if (/^-(?!-- )/.test(line)) removed++;
	}
	return { added, removed };
}
