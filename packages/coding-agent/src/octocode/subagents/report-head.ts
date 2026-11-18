import { truncateHead } from "../../core/tools/index.ts";
import { formatBytes } from "@octocodeai/octocode-common/bytes";
import { cutText } from "@octocodeai/octocode-common/text";
import { REPORT_MAX_BYTES } from "../native/prompts/report.ts";

export const REPORT_MAX_LINES = 200;

export interface ReportHead {
	head: string;
	bytes: number;
	lines: number;
	firstLineBytes: number;
}

export const emptyHead = (): ReportHead => ({ head: "", bytes: 0, lines: 1, firstLineBytes: 0 });

/** Keep enough raw text to cut a preview; totals describe the complete report on disk. */
export function appendHead(before: ReportHead, section: string): ReportHead {
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

export function headPreview(report: ReportHead): string {
	const cut = truncateHead(report.head, { maxBytes: REPORT_MAX_BYTES, maxLines: REPORT_MAX_LINES });
	if (report.bytes <= REPORT_MAX_BYTES && report.lines <= REPORT_MAX_LINES) return report.head;
	if (cut.content === "") {
		const head = cutText(report.head, REPORT_MAX_BYTES);
		return `${head}\n\n[Output trimmed: the first line alone is ${formatBytes(report.firstLineBytes, "compact")}; kept its first ${formatBytes(Buffer.byteLength(head), "compact")} (${formatBytes(report.bytes, "compact")} in all).]`;
	}
	return `${cut.content}\n\n[Output trimmed: ${cut.outputLines} of ${report.lines} lines (${formatBytes(cut.outputBytes, "compact")} of ${formatBytes(report.bytes, "compact")}).]`;
}
