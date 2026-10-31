import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatSize, truncateHead } from "../../core/tools/index.ts";
import { REPORT_MAX_BYTES, REPORT_STATUSES, type ReportStatus } from "../instructions/report.ts";
import { shortPath } from "../shared/format.ts";
import { visibleControls } from "../shared/sanitize.ts";
import { JOB_TYPE } from "../shared/messages.ts";
import { capOutput, contentText, cutText } from "../shared/util.ts";
import {
	type ResultContract,
	type StructuredResultV1,
	unavailableResult,
	validateResultAnswer,
} from "./result-schema.ts";
import { errorMessage as describeError, isRecord } from "@octocodeai/octocode-contracts/guards";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { snapshotReport, type ReportArtifact } from "../shared/report-artifact.ts";

const REPORT_MAX_LINES = 200;
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
	const details = isRecord(message.details) ? message.details : {};
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

/** The saved whole report a report points at: the last pointer line, and only a scratch path (never one the child wrote). */
export function reportFilePath(text: string | undefined): string | undefined {
	const pointers = [...(text ?? "").matchAll(/^Full report: (.+?) \(read only/gm)].map((match) => match[1]);
	const file = pointers.at(-1);
	return file?.includes("tmp/agents/") ? file : undefined;
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
	private artifact: ReportArtifact | undefined;
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

	/**
	 * A message reached the child; `job`: the notice line when it is the child's own background job ending. A `quiet` job
	 * report starts no turn: it adds its line to the report already given instead of a follow-up answer.
	 */
	incoming(role: unknown, job?: string, quiet?: boolean): void {
		if (quiet && job) {
			if (this.sections > 0) this.note(`After this report: ${job}`);
			return;
		}
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
		this.write(section, append);
		this.signature = signature;
		this.fresh = false;
	}

	/** A line added to the latest report without a model turn; a later answer still starts its own section. */
	private note(line: string): void {
		this.before = this.full;
		this.sectionStart = this.full.bytes;
		this.write(`\n\n${line}`, true);
	}

	/** Appends `section` to the report (or replaces the current section with it), on disk once the report is long. */
	private write(section: string, append: boolean): void {
		const whole = appendHead(this.before, section);
		this.artifact = undefined;
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
			? `Full report: ${shortPath(artifact.path)} (read only the parts you need).`
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
