import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatSize, truncateHead } from "../../core/tools/index.ts";
import { REPORT_MAX_BYTES, REPORT_STATUSES, type ReportStatus } from "../instructions/report.ts";
import { shortPath } from "../shared/format.ts";
import { visibleControls } from "../shared/sanitize.ts";
import { capOutput, cutText } from "../shared/util.ts";
import {
	type ResultContract,
	type StructuredResultV1,
	unavailableResult,
	validateResultAnswer,
} from "./result-schema.ts";
import { errorMessage as describeError } from "../../utils/guards.ts";

const REPORT_MAX_LINES = 200;
const SEPARATOR = "\n\n---\n\n";
const preview = (text: string) => capOutput(text, REPORT_MAX_BYTES, REPORT_MAX_LINES);

/** One label a report may put before its outcome word: `Report: partial`, `**Status:** done`, `Outcome: blocked`. */
const OUTCOME_LABEL = /^[^\p{L}\p{N}]*(?:report|status|outcome)[^\p{L}\p{N}:]*:[^\p{L}\p{N}]*/iu;

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
	if (first && !contradicted(token, lead.slice(token.length))) return { status: first, source: "first" };
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

interface ReportHead {
	head: string;
	bytes: number;
	lines: number;
	firstLineBytes: number;
}

const emptyHead = (): ReportHead => ({ head: "", bytes: 0, lines: 1, firstLineBytes: 0 });

/** Keep enough raw text to cut a preview; totals describe the complete report on disk. */
function appendHead(before: ReportHead, section: string): ReportHead {
	const newline = section.indexOf("\n");
	return {
		// Four extra bytes retain an overflow code point, so a multibyte boundary cannot hide a cut.
		head: cutText(before.head + section, REPORT_MAX_BYTES + 4)
			.split("\n")
			.slice(0, REPORT_MAX_LINES + 1)
			.join("\n"),
		bytes: before.bytes + Buffer.byteLength(section),
		lines: before.lines + (section.match(/\n/g)?.length ?? 0),
		firstLineBytes:
			before.firstLineBytes +
			(before.lines === 1 ? Buffer.byteLength(newline < 0 ? section : section.slice(0, newline)) : 0),
	};
}

function headPreview(report: ReportHead): string {
	const cut = truncateHead(report.head, { maxBytes: REPORT_MAX_BYTES, maxLines: REPORT_MAX_LINES });
	if (report.bytes <= REPORT_MAX_BYTES && report.lines <= REPORT_MAX_LINES) return report.head;
	if (cut.content === "") {
		const head = cutText(report.head, REPORT_MAX_BYTES);
		return `${head}\n\n[Output trimmed: the first line alone is ${formatSize(report.firstLineBytes)}; kept its first ${formatSize(Buffer.byteLength(head))} (${formatSize(report.bytes)} in all).]`;
	}
	return `${cut.content}\n\n[Output trimmed: ${cut.outputLines} of ${report.lines} lines (${formatSize(cut.outputBytes)} of ${formatSize(report.bytes)}).]`;
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
	private fresh = true;
	private failure: string | undefined;
	private outcome: { status: ReportStatus; source: OutcomeSource } | undefined;
	private file: string | undefined;
	private partialFile: string | undefined;
	private spillFailed = false;
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

	/** A message reached the child; `job`: the notice line when it is the child's own background job ending. */
	incoming(role: unknown, job?: string): void {
		if (role === "user" || role === "custom") {
			this.fresh = true;
			this.job = role === "custom" && job && this.sections > 0 ? job : undefined;
			if (this.resultContract) this.structured = unavailableResult(this.resultContract);
		}
	}

	answer(raw: string | undefined, stopReason: unknown, errorMessage?: unknown): void {
		const failed = stopReason === "error" || stopReason === "aborted" || stopReason === "length";
		this.failure = failed
			? visibleControls(
					describeError(
						errorMessage ??
							(stopReason === "length" ? "Model output limit reached; the report is incomplete" : stopReason),
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
		this.lastText = preview(text);
		if (stopReason === "toolUse" || failed) {
			this.partialFile = undefined;
			if (this.sections === 0 && this.lastText !== text && this.scratch) {
				try {
					const file = path.join(this.scratch, "partial-report.md");
					fs.writeFileSync(file, text);
					this.partialFile = file;
				} catch {
					/* Keep the bounded partial answer when disk is unavailable. */
				}
			}
			return;
		}
		const append = this.fresh || this.sections === 0;
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
		const whole = appendHead(this.before, section);
		const capped = headPreview(whole);
		try {
			if (this.file) {
				if (!append) fs.truncateSync(this.file, this.sectionStart);
				fs.appendFileSync(this.file, section);
			} else if (
				!this.spillFailed &&
				(whole.bytes > REPORT_MAX_BYTES || whole.lines > REPORT_MAX_LINES) &&
				this.scratch
			) {
				const file = path.join(this.scratch, "report.md");
				fs.writeFileSync(file, this.before.head + section);
				this.file = file;
			}
		} catch {
			// A disk failure must not discard the bounded answer or advertise an incomplete report.
			this.file = undefined;
			this.spillFailed = true;
		}
		this.full = whole;
		this.text = capped;
		this.signature = signature;
		this.fresh = false;
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
	} {
		if (this.sections === 0) {
			const pointer = this.partialFile
				? `Full partial report: ${shortPath(this.partialFile)} (read only the parts you need).`
				: undefined;
			return {
				text: `${this.lastText}${pointer ? `\n${pointer}` : ""}`,
				body: this.lastText,
				...(pointer ? { pointer } : {}),
				answered: false,
				...(this.failure ? { error: this.failure } : {}),
				...(this.resultContract ? { structured: unavailableResult(this.resultContract) } : {}),
			};
		}
		const body = this.failure ? `${this.text}${SEPARATOR}(A later follow-up turn failed: ${this.failure})` : this.text;
		const pointer = this.file ? `Full report: ${shortPath(this.file)} (read only the parts you need).` : undefined;
		return {
			text: `${body}${pointer ? `\n${pointer}` : ""}`,
			body,
			...(pointer ? { pointer } : {}),
			...(this.outcome ? { outcome: this.outcome.status, outcomeSource: this.outcome.source } : {}),
			...(this.failure ? { error: this.failure } : {}),
			...(this.resultContract ? { structured: this.structured ?? unavailableResult(this.resultContract) } : {}),
			answered: true,
		};
	}
}
