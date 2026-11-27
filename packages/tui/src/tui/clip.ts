import { isImageLine } from "../terminal-image.ts";
import { sliceByColumn } from "../utils/columns.ts";
import { visibleWidth } from "../utils/width.ts";
import { applyLineReset } from "./composite.ts";
import { arrayWithPrefix } from "./row-arrays.ts";

/** Line reset + width clipping for one terminal row. */
export const finishScreenRow = (line: string, width: number): string => clipLineToWidth(applyLineReset(line), width);

/**
 * Clip rows wider than the terminal. A component that returns an over-wide row (an extension, a custom
 * component) must not wrap the terminal row or crash the renderer. Image rows carry their own sizing and stay.
 */
export function clipLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => clipLineToWidth(line, width));
}

/** One row of `clipLinesToWidth`. */
export function clipLineToWidth(line: string, width: number): string {
	return isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true);
}

/**
 * `finish` of each line, remembered from the last frame: a line that came back unchanged costs one comparison, so a
 * frame's cost follows what changed and not how long the transcript is. Lines keep their place in a growing transcript.
 * Leading rows the caller vouches for (`unchanged`) are not compared at all.
 */
export class FinishedLines {
	private inputs: readonly string[] = [];
	private outputs: string[] = [];
	private width = -1;
	private readonly finish: (line: string, width: number) => string;

	constructor(finish: (line: string, width: number) => string) {
		this.finish = finish;
	}

	reset(): void {
		this.inputs = [];
		this.outputs = [];
		this.width = -1;
	}

	/** The input is read-only here; the caller gets a new array, so a frame's later edits cannot reach the memory. */
	apply(lines: readonly string[], width: number): string[] {
		const result = this.applyFrom(lines, width, 0).lines;
		this.inputs = lines.slice();
		return result.slice();
	}

	/**
	 * `apply`, where the first `unchanged` rows of `lines` are the same strings as in the last call's input. The caller
	 * must not change `lines` afterwards, nor the result. The result's `unchanged` counts the leading rows that equal the
	 * last result's.
	 */
	applyFrom(lines: readonly string[], width: number, unchanged: number): { lines: string[]; unchanged: number } {
		const same = width === this.width;
		const keep = same ? Math.max(0, Math.min(unchanged, this.inputs.length, lines.length)) : 0;
		if (keep === lines.length && keep === this.outputs.length) {
			this.inputs = lines;
			return { lines: this.outputs, unchanged: keep };
		}
		// Without a prefix the rows are written in order into an empty array.
		const outputs = arrayWithPrefix(this.outputs, keep, lines.length) ?? [];
		const inputs = this.inputs;
		for (let index = keep; index < lines.length; index++) {
			const line = lines[index];
			outputs[index] = same && inputs[index] === line ? this.outputs[index] : this.finish(line, width);
		}
		this.inputs = lines;
		this.outputs = outputs;
		this.width = width;
		// The next call builds a new array, so this one is never changed again and can be handed out.
		return { lines: outputs, unchanged: keep };
	}
}
