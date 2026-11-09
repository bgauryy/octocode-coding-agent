import { renderInstruction } from "../../core/prompt-template.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { REPORT_MAX_BYTES, REPORT_STATUSES, type ReportStatus } from "../instructions/report.ts";
import { shortPath } from "../../utils/display-path.ts";
import { redactSecrets, visibleControls } from "../../../../common/src/sanitize.ts";
import { JOB_TYPE } from "../shared/messages.ts";
import { capOutput, contentText } from "../shared/util.ts";
import {
	type ResultContract,
	type StructuredResultV1,
	unavailableResult,
	validateResultAnswer,
} from "./result-schema.ts";
import { asRecord, errorMessage as describeError } from "@octocodeai/octocode-contracts/guards";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import {
	appendScratchFile,
	snapshotReport,
	writeScratchFile,
	type ReportArtifact,
} from "../child-sessions/report-artifact.ts";
import { appendHead, emptyHead, headPreview, REPORT_MAX_LINES } from "./report-head.ts";
import { isWaitingLine } from "./pending-waits.ts";

const SEPARATOR = "\n\n---\n\n";
const preview = (text: string) => capOutput(text, REPORT_MAX_BYTES, REPORT_MAX_LINES);

/**
 * The child's own background bash job report, read from its message (`shared/messages.ts` `JOB_TYPE`): its `Background
 * bash …` line (else its first line), and `quiet` when it was recorded without starting a turn (`files/bash.ts`: every job
 * of a subagent), with the log path the parent can read.
 */
export function jobNotice(message: { customType?: unknown; content?: unknown; details?: unknown }): {
	job?: string;
	quiet?: true;
} {
	if (message.customType !== JOB_TYPE) return {};
	const lines = contentText(message.content).split("\n");
	const line = visibleControls(lines.find((text) => text.startsWith("Background bash ")) ?? lines[0] ?? "");
	if (!line) return {};
	const details = asRecord(message.details);
	if (details.quiet !== true) return { job: line };
	const log = typeof details.log === "string" ? ` (log: ${visibleControls(shortPath(details.log))})` : "";
	return { job: `${line}${log}`, quiet: true };
}

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

/** Where a report named its outcome: its first word (the preferred form) or a labelled last line. */
type OutcomeSource = "first" | "last";

/**
 * A report's outcome and where it stands, or undefined when it names none (an unknown outcome, never a failure). The
 * first word counts first: case and light markup around it (`**Blocked**:`, `done.`) do not matter, and one `Report:`,
 * `Status:` or `Outcome:` label may come before it (`**Report: partial.**`). Otherwise the last non-empty line counts
 * when it is exactly such a label and one outcome word (`outcome: done`), so trailing prose never matches.
 */
export function reportOutcome(text: string | undefined): { status: ReportStatus; source: OutcomeSource } | undefined {
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

/**
 * A bounded preview and an incremental disk report. Retries replace the current section; incoming messages start a new
 * one. The preview is always cut from the whole uncut report, so follow-ups never stack truncation notices.
 */
export class ReportTracker {
	/** Bounded raw heads and exact totals; retries restore the state before the current section. */
	private full = emptyHead();
	private before = emptyHead();
	private text = "";
	private lastText = "";
	private signature = "";
	private sections = 0;
	private sectionStart = 0;
	/** The only section is a waiting line kept because a report with nothing in it is no answer; a later answer replaces it. */
	private waitOnly = false;
	private fresh = true;
	private failure: string | undefined;
	private outcome: { status: ReportStatus; source: OutcomeSource } | undefined;
	private file: string | undefined;
	private artifact: ReportArtifact | undefined;
	private partialFile: string | undefined;
	private spillFailed = false;
	/** Why the whole report could not be saved to its scratch folder (a refused link, a full disk); the preview says so. */
	private unsaved: string | undefined;
	/** The same for a partial answer, which belongs to a report that has no section yet. */
	private partialUnsaved: string | undefined;
	private structured: StructuredResultV1 | undefined;
	/** The notice of the child's own background job that woke it after it reported: the next section is a follow-up. */
	private job: string | undefined;
	/** The outcome before the current section: what a follow-up that names none keeps. */
	private prior: { status: ReportStatus; source: OutcomeSource } | undefined;
	private readonly resultContract?: ResultContract;

	private readonly scratch?: string;
	constructor(scratch?: string, resultContract?: ResultContract) {
		this.scratch = scratch;
		this.resultContract = resultContract;
	}

	/** At least one answer is in: the report exists, however its follow-ups end. */
	get hasReport(): boolean {
		return this.sections > 0;
	}

	/**
	 * A message reached the child; `job`: the notice line when it is the child's own background job ending. A `quiet` job
	 * report starts no turn: it adds its line to the report already given instead of a follow-up answer.
	 */
	incoming(role: unknown, job?: string, quiet?: boolean): void {
		if (quiet && job) {
			if (this.sections === 0) return;
			this.note(`After this report: ${job}`);
			// The run-end hold (`files/bash/child-hold.ts`) can give the child a turn on it: that answer is a follow-up section,
			// not a replacement glued to the report above.
			this.fresh = true;
			this.job = job;
			return;
		}
		if (role === "user" || role === "custom") {
			this.fresh = true;
			this.job = role === "custom" && job && this.sections > 0 ? job : undefined;
			if (this.resultContract) this.structured = unavailableResult(this.resultContract);
		}
	}

	/**
	 * `waiting`: the child still has a background job or timer pending, so a waiting-only text is not its report.
	 * `reminder`: its own timer woke this turn and no tool ran, so after a report its text only echoes the reminder.
	 */
	answer(
		answerText: string | undefined,
		stopReason: unknown,
		errorMessage?: unknown,
		waiting = false,
		reminder = false,
	): void {
		// The child's answer and failure reach the parent model and the saved report: a credential it quotes (an error body, a
		// file it read) is removed here, so the preview, the scratch files and the structured result all hold clean text.
		const raw = answerText === undefined ? undefined : redactSecrets(answerText);
		const failed = stopReason === "error" || stopReason === "aborted" || stopReason === "length";
		this.failure = failed
			? redactSecrets(
					visibleControls(
						describeError(
							errorMessage ??
								(stopReason === "length" ? "Model output limit reached; the report is incomplete" : stopReason),
						),
					),
				)
			: undefined;
		if (this.resultContract && stopReason !== "toolUse")
			this.structured =
				failed || !raw ? unavailableResult(this.resultContract) : validateResultAnswer(raw, this.resultContract);
		if (!raw) {
			// An earlier report is evidence, not an answer to a new message that finished without text.
			if (!failed && stopReason !== "toolUse" && this.fresh && this.sections > 0)
				this.failure = "Subagent follow-up ended without a final answer";
			return;
		}
		const text = visibleControls(raw);
		// A waiting line after a report pads it; the first answer is kept for now, as a report with nothing in it would be no
		// answer, and the next section replaces it (`restart`).
		if (waiting && !failed && stopReason !== "toolUse" && this.sections > 0 && isWaitingLine(text)) return;
		if (reminder && !failed && stopReason !== "toolUse" && this.sections > 0) return;
		this.lastText = preview(text);
		if (stopReason === "toolUse" || failed) {
			this.partialFile = undefined;
			this.partialUnsaved = undefined;
			if (this.sections === 0 && this.lastText !== text && this.scratch) {
				try {
					const file = path.join(this.scratch, "partial-report.md");
					writeScratchFile(file, text);
					this.partialFile = file;
				} catch (error) {
					// Keep the bounded partial answer, and say why the whole one was not saved.
					this.partialUnsaved = describeError(error);
				}
			}
			return;
		}
		const append = this.fresh || this.sections === 0;
		if (append && this.waitOnly) this.restart();
		// One task, one report: the answer to the child's own job notice extends the report it already gave, and keeps that
		// report's outcome unless it names a new one. A new task (a message from the parent) is judged on its own.
		const followUp = this.job;
		if (append) this.prior = this.outcome;
		this.outcome = reportOutcome(text) ?? (followUp ? this.prior : undefined);
		const signature = createHash("sha512").update(text).digest("hex");
		if (append && signature === this.signature) {
			this.fresh = false;
			return;
		}
		if (append) {
			this.before = this.full;
			this.sectionStart = this.full.bytes;
			this.sections++;
		}
		const section = `${this.sections > 1 ? SEPARATOR : ""}${followUp ? `Follow-up to the report above (${followUp}):\n` : ""}${text}`;
		this.write(section, append);
		this.waitOnly = this.sections === 1 && isWaitingLine(text);
		this.signature = signature;
		this.fresh = false;
	}

	/** Drops the waiting-only section that stood in for a report: the answer that follows it is the report. */
	private restart(): void {
		this.full = emptyHead();
		this.before = emptyHead();
		this.sections = 0;
		this.sectionStart = 0;
		this.signature = "";
		this.outcome = undefined;
		this.prior = undefined;
		this.job = undefined;
		this.waitOnly = false;
	}

	/** A line added to the latest report without a model turn; a later answer still starts its own section. */
	private note(line: string): void {
		this.before = this.full;
		this.sectionStart = this.full.bytes;
		this.waitOnly = false;
		this.write(`\n\n${line}`, true);
	}

	/** Appends `section` to the report (or replaces the current section with it), on disk once the report is long. */
	private write(section: string, append: boolean): void {
		const whole = appendHead(this.before, section);
		this.artifact = undefined;
		const capped = headPreview(whole);
		try {
			if (this.file) {
				appendScratchFile(this.file, section, append ? undefined : this.sectionStart);
			} else if (
				!this.spillFailed &&
				(whole.bytes > REPORT_MAX_BYTES || whole.lines > REPORT_MAX_LINES) &&
				this.scratch
			) {
				const file = path.join(this.scratch, "report.md");
				writeScratchFile(file, this.before.head + section);
				this.file = file;
			}
		} catch (error) {
			// A disk failure or a refused path must not discard the bounded answer or advertise an incomplete report.
			this.file = undefined;
			this.spillFailed = true;
			this.unsaved = describeError(error);
		}
		this.full = whole;
		this.text = capped;
	}

	private unsavedNote(why: string): string {
		return `[The whole report was not saved to a file: ${why}.]`;
	}

	/**
	 * The report as returned to the caller: `text` is `body` plus, when the whole text is saved in a file, the `pointer`
	 * line naming it. A caller that shortens `body` keeps the pointer.
	 */
	result(): {
		text: string;
		body: string;
		pointer?: string;
		error?: string;
		outcome?: ReportStatus;
		outcomeSource?: OutcomeSource;
		answered: boolean;
		structured?: StructuredResultV1;
		reportArtifact?: ReportArtifact;
	} {
		if (this.sections === 0) {
			const pointer = this.partialFile
				? renderInstruction("notices/subagents/report-pointer.md", {
						partial: true,
						file: shortPath(this.partialFile),
					})
				: undefined;
			const body =
				this.partialUnsaved && !pointer
					? `${this.lastText}\n\n${this.unsavedNote(this.partialUnsaved)}`
					: this.lastText;
			return {
				text: `${body}${pointer ? `\n${pointer}` : ""}`,
				body,
				...(pointer ? { pointer } : {}),
				answered: false,
				...(this.failure ? { error: this.failure } : {}),
				...(this.resultContract ? { structured: unavailableResult(this.resultContract) } : {}),
			};
		}
		const shown = this.unsaved && !this.file ? `${this.text}\n\n${this.unsavedNote(this.unsaved)}` : this.text;
		const body = this.failure ? `${shown}${SEPARATOR}(A later follow-up turn failed: ${this.failure})` : shown;
		if (!this.artifact) {
			try {
				this.artifact = this.file ? snapshotReport(this.file) : { sha256: sha256(body) };
			} catch {
				// A failed snapshot cannot advertise a mutable or incomplete artifact as this report's version.
				this.artifact = { sha256: sha256(body) };
			}
		}
		// A failed follow-up's current answer includes the failure notice, not only the older saved report.
		const artifact = this.failure ? { sha256: sha256(body) } : this.artifact;
		const pointer = artifact.path
			? renderInstruction("notices/subagents/report-pointer.md", { partial: false, file: shortPath(artifact.path) })
			: undefined;
		return {
			text: `${body}${pointer ? `\n${pointer}` : ""}`,
			body,
			...(pointer ? { pointer } : {}),
			...(this.outcome ? { outcome: this.outcome.status, outcomeSource: this.outcome.source } : {}),
			...(this.failure ? { error: this.failure } : {}),
			...(this.resultContract ? { structured: this.structured ?? unavailableResult(this.resultContract) } : {}),
			answered: true,
			reportArtifact: artifact,
		};
	}
}
