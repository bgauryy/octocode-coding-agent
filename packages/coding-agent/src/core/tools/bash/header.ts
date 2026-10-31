import { formatBytes } from "../../../utils/bytes.ts";
import type { TruncationResult } from "../truncate.ts";

/** How a command ended, as the first part of the header. */
export type BashEnd =
	| { kind: "exit"; code: number; seconds: number }
	| { kind: "timeout"; seconds: number }
	| { kind: "aborted" | "terminated"; seconds: number };

/** A whole number with thousands separators. */
export const formatCount = (n: number) => n.toLocaleString("en-US");

/** The part of the header that says what was cut, or undefined for whole output. */
function trimmed(truncation: TruncationResult, lastLineBytes: number): string | undefined {
	if (!truncation.truncated) return undefined;
	if (truncation.lastLinePartial) {
		const part = formatBytes(truncation.outputBytes - (truncation.headBytes ?? 0), "spaced");
		return `trimmed: last ${part} of line ${formatCount(truncation.totalLines)} (line is ${formatBytes(lastLineBytes, "spaced")})`;
	}
	if (truncation.headLines === undefined) {
		return `trimmed: last ${formatCount(truncation.outputLines)} ${truncation.outputLines === 1 ? "line" : "lines"}`;
	}
	const matched = truncation.matchedLines ? ` + ${truncation.matchedLines} matched` : "";
	return `trimmed: first ${formatCount(truncation.headLines)} + last ${formatCount(truncation.tailLines ?? 0)} lines${matched}`;
}

/**
 * The first line of a foreground bash result, e.g. `[exit 0 · 4.2s · 312 lines · 18 KB]`; a trimmed result adds what
 * was kept and where the full output is. A command that timed out shows its deadline instead of a duration.
 */
export function formatBashHeader(
	end: BashEnd,
	output: {
		totalLines: number;
		totalBytes: number;
		truncation: TruncationResult;
		fullOutputPath?: string;
		lastLineBytes: number;
	},
): string {
	const seconds = `${end.seconds}s`;
	const parts =
		end.kind === "exit"
			? [`exit ${end.code}`, seconds]
			: end.kind === "timeout"
				? [`timed out after ${seconds}`]
				: [end.kind === "aborted" ? "aborted" : "terminated (no exit code)", seconds];
	parts.push(
		output.totalLines === 0
			? "no output"
			: `${formatCount(output.totalLines)} ${output.totalLines === 1 ? "line" : "lines"} · ${formatBytes(output.totalBytes, "spaced")}`,
	);
	const cut = trimmed(output.truncation, output.lastLineBytes);
	if (cut) {
		parts.push(cut);
		if (output.fullOutputPath) parts.push(`full output: ${output.fullOutputPath}`);
	}
	return `[${parts.join(" · ")}]`;
}
