import { REPORT_STATUSES, type ReportStatus } from "../instructions/report.ts";

/** One label a report may put before its outcome word: `Report: partial`, `**Status:** done`, `Outcome: blocked`. */
export const OUTCOME_LABEL = /^[^\p{L}\p{N}]*(?:report|status|outcome)[^\p{L}\p{N}:]*:[^\p{L}\p{N}]*/iu;

const statusWord = (token: string): ReportStatus | undefined => {
	const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
	return REPORT_STATUSES.find((status) => status === word);
};

/**
 * `Done with the audit, but blocked by X`: an outcome word that is plain prose (no punctuation after it) and whose line
 * names another outcome. Neither reading is safe, so the report names none (unknown, never a failure).
 */
function contradicted(token: string, rest: string): boolean {
	if (/[^\p{L}]$/u.test(token) || !/^[ \t]*[\p{L}\p{N}]/u.test(rest)) return false;
	const line = rest.split("\n", 1)[0] ?? "";
	return line.split(/[^\p{L}]+/u).some((word) => statusWord(word) !== undefined);
}

/** What may follow a delimited outcome word: the end of the line, punctuation, `(`, or a spaced dash. */
const DELIMITED = /^(?:[ \t]*(?:\n|$)|[ \t]*[.:,;!?(]|[ \t]*[-\u2013\u2014](?:[ \t]|$))/u;

/**
 * Whether the first word is the report's outcome rather than the start of a sentence (`Failed login attempts now lock…`).
 * It counts when delimited, with markup around the word allowed (`**Blocked**:`) but not alone (`**Blocked** requests
 * are logged`). `done` also counts as plain prose (`Done with the audit`) unless its line names another outcome.
 */
function leadsOutcome(status: ReportStatus, token: string, rest: string): boolean {
	const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
	const trailing = token.slice(token.lastIndexOf(word) + word.length);
	const after = (trailing + rest).replace(/^[*_`~]+/, "");
	if (DELIMITED.test(after)) return true;
	return status === "done" && !contradicted(token, rest);
}

/**
 * Where a report named its outcome: its first word (the preferred form) or a labelled last line; `asked`: it named none,
 * so the outcome is the child's answer to the one question about it, or `partial` when that named none either.
 */
export type OutcomeSource = "first" | "last" | "asked";

/**
 * A report's outcome and where it stands, or undefined when it names none (an unknown outcome, never a failure). The
 * first word counts first: case and light markup around it (`**Blocked**:`, `done.`) do not matter, and one `Report:`,
 * `Status:` or `Outcome:` label may come before it (`**Report: partial.**`). Otherwise the last non-empty line counts
 * when it is exactly such a label and one outcome word (`outcome: done`), so trailing prose never matches.
 */
export function reportOutcome(
	text: string | undefined,
): { status: ReportStatus; source: "first" | "last" } | undefined {
	const body = (text ?? "").trim();
	const lead = body.replace(OUTCOME_LABEL, "");
	const token = lead.split(/\s/, 1)[0] ?? "";
	const first = statusWord(token);
	if (first && leadsOutcome(first, token, lead.slice(token.length))) return { status: first, source: "first" };
	const last = body.split("\n").at(-1)?.trim() ?? "";
	if (!OUTCOME_LABEL.test(last)) return undefined;
	const rest = last.replace(OUTCOME_LABEL, "").trim();
	const status = /\s/.test(rest) ? undefined : statusWord(rest);
	return status ? { status, source: "last" } : undefined;
}

/** The outcome a report names (`reportOutcome`), without where it stands. */
export function reportStatus(text: string | undefined): ReportStatus | undefined {
	return reportOutcome(text)?.status;
}

/** A line that heads a section: a markdown heading, a bold label, or a short label (`Files:`, `Open questions: none`). */
const HEADING = /^(?:#{1,6}\s+\S|\*\*[^*\n]{1,40}\*\*:?\s*$|[\p{Lu}][\p{L}]{0,24}(?: [\p{L}]{1,24})?:(?:\s|$))/u;
/** A heading that opens the verification section; with `:`, the same line may carry the whole of it (`Verified: ran X`). */
const VERIFICATION = /^[^\p{L}\p{N}]*(?:verification|verified|checks?)\b[^\p{L}\p{N}:]*(?::\s*(.*))?$/iu;
/** What a list line puts before its entry: a bullet, a number, a checkbox. */
const LIST_MARK = /^(?:[-*+•]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/;

/**
 * The checks a report names in its verification section (the contract asks for the result, verification and open
 * questions after the outcome word): the entries under a `Verification`, `Verified` or `Checks` heading, up to the next
 * heading, or the one line `Verified: ran X` names. Undefined when the report has no such section; empty when it is
 * there with nothing under it.
 */
export function reportChecks(text: string | undefined): string[] | undefined {
	const lines = (text ?? "").split("\n");
	const start = lines.findIndex((line) => VERIFICATION.test(line.trim()));
	if (start < 0) return undefined;
	const inline = VERIFICATION.exec(lines[start].trim())?.[1]?.trim() ?? "";
	if (/[\p{L}\p{N}]/u.test(inline)) return [inline];
	const checks: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const trimmed = line.trim();
		if (HEADING.test(trimmed)) break;
		const entry = trimmed.replace(LIST_MARK, "").trim();
		if (entry) checks.push(entry);
	}
	return checks;
}
