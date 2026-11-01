/**
 * What a trimmed command result keeps besides its start and end: lines from the elided middle that report a
 * failure, and one line for each run of identical lines. Both work on text that is already free of terminal escapes.
 */

/** What a terminal shows after carriage-return redraws of one line: its last non-empty rewrite. */
export function collapseLine(line: string): string {
	if (!line.includes("\r")) return line;
	const parts = line.split("\r");
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i]) return parts[i];
	}
	return "";
}

/** `collapseLine` for each line of terminated text; CRLF is a newline. */
export function collapseCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.split("\n").map(collapseLine).join("\n");
}

/** Lines that usually say what went wrong: compiler and test errors, crashes, assertion output. */
const FAILURE_LINE = /error|fail|panic|exception|traceback|fatal|assert|✗|✖|npm ERR!/i;
/** The words of `FAILURE_LINE`, for the note that tells a reader what the shown lines matched. */
export const FAILURE_WORDS = "error, fail, panic, exception, traceback, fatal, assert";

/** The most matched lines one result shows, and the most bytes they may take together. */
const MATCHED_MAX_LINES = 20;
const MATCHED_MAX_BYTES = 2048;
/** One matched line is cut to this many characters, so a minified or very long line cannot use the whole allowance. */
const MATCHED_LINE_CHARS = 160;
/**
 * Matches kept while the output streams. The elided matches come before the ones inside the final window, so
 * the first `MATCHED_MAX_LINES` of the elided ones are among the first candidates; the surplus covers lines the
 * head shows after repeated lines in it were collapsed.
 */
const CANDIDATE_CAP = 100;
/** A run of at least this many identical consecutive lines shows as one line and a count. */
const MIN_REPEATS = 3;

export interface MatchedLine {
	/** 1-based line number in the output. */
	line: number;
	text: string;
}

/** Collects failure lines as complete lines pass; memory stays at `CANDIDATE_CAP` short lines however long the output. */
export class FailureLineScanner {
	private readonly found: MatchedLine[] = [];

	/** Whether more matches would be dropped. */
	get full(): boolean {
		return this.found.length >= CANDIDATE_CAP;
	}

	scan(line: number, text: string): void {
		if (this.found.length >= CANDIDATE_CAP || !FAILURE_LINE.test(text)) return;
		if (this.found.at(-1)?.line === line) return;
		const trimmed = text.trim();
		this.found.push({
			line,
			text: trimmed.length > MATCHED_LINE_CHARS ? `${trimmed.slice(0, MATCHED_LINE_CHARS)}…` : trimmed,
		});
	}

	/** The matched lines numbered `from` to `to`, within the line and byte allowance; nothing outside that range. */
	between(from: number, to: number): MatchedLine[] {
		const picked: MatchedLine[] = [];
		let bytes = 0;
		for (const match of this.found) {
			if (match.line < from || match.line > to) continue;
			const size = Buffer.byteLength(formatMatchedLine(match), "utf-8") + 1;
			if (picked.length >= MATCHED_MAX_LINES || bytes + size > MATCHED_MAX_BYTES) break;
			picked.push(match);
			bytes += size;
		}
		return picked;
	}
}

function formatMatchedLine(match: MatchedLine): string {
	return `  ${match.line}: ${match.text}`;
}

/** The matched lines as the block shown after the head: one numbered line each. */
export function formatMatchedBlock(matches: readonly MatchedLine[]): string {
	return matches.map(formatMatchedLine).join("\n");
}

/**
 * `lines` with each run of identical lines (at least `MIN_REPEATS`) replaced by the line and a `[… repeated N×]`
 * line, N being the length of the run. `extras[i]` is how many output lines `result[i]` stands for beyond itself.
 */
export function collapseRepeats(lines: readonly string[]): { lines: string[]; extras: number[] } {
	const result: string[] = [];
	const extras: number[] = [];
	for (let i = 0; i < lines.length;) {
		let end = i + 1;
		while (end < lines.length && lines[end] === lines[i]) end++;
		const run = end - i;
		if (run >= MIN_REPEATS) {
			result.push(lines[i], `[… repeated ${run}×]`);
			extras.push(0, run - 2);
		} else {
			for (let at = i; at < end; at++) {
				result.push(lines[at]);
				extras.push(0);
			}
		}
		i = end;
	}
	return { lines: result, extras };
}

/** `collapseRepeats` for text: a final newline stays, and `extras` is as in `collapseRepeats`. */
export function collapseText(text: string): { text: string; extras: number[] } {
	const endsWithNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (endsWithNewline) lines.pop();
	const collapsed = collapseRepeats(lines);
	return { text: collapsed.lines.join("\n") + (endsWithNewline ? "\n" : ""), extras: collapsed.extras };
}

/** Output lines the last `shown` collapsed lines stand for; `extras` is empty when nothing was collapsed. */
export function coveredLines(shown: number, extras: readonly number[]): number {
	let covered = shown;
	for (let i = Math.max(0, extras.length - shown); i < extras.length; i++) covered += extras[i];
	return covered;
}
