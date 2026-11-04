import { isImageLine } from "../terminal-image.ts";
import { sliceByColumn } from "../utils/columns.ts";
import { visibleWidth } from "../utils/width.ts";

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
 */
export class FinishedLines {
	private inputs: string[] = [];
	private outputs: string[] = [];
	private width = -1;
	private readonly finish: (line: string, width: number) => string;

	constructor(finish: (line: string, width: number) => string) {
		this.finish = finish;
	}

	/** The input is read-only here; the caller gets a new array, so a frame's later edits cannot reach the memory. */
	apply(lines: readonly string[], width: number): string[] {
		const same = width === this.width;
		const outputs = lines.map((line, index) =>
			same && this.inputs[index] === line ? this.outputs[index] : this.finish(line, width),
		);
		this.inputs = lines.slice();
		this.outputs = outputs;
		this.width = width;
		return outputs.slice();
	}
}
