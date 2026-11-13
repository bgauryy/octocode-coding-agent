import { clipLineToWidth, FinishedLines } from "../tui/clip.ts";
import { applyLineReset } from "../tui/composite.ts";
import { frameLines, isRowFrame, type RowSource, sharedRowsOf } from "../tui/row-source.ts";
import { CursorRows } from "./cursor-rows.ts";
import { FrameRows } from "./frame-rows.ts";

/** One frame's rows as the terminal gets them, and what they share with the last frame's. */
export interface FinishedFrame {
	lines: string[];
	cursor: { row: number; col: number } | null;
	/** The last frame's rows, and how many leading rows of `lines` are the same strings. */
	previous: readonly string[] | undefined;
	unchanged: number;
}

/** A row wider than the terminal would wrap and shift every row below it, in the full render and the diff alike. */
const finishRow = (line: string, width: number): string => clipLineToWidth(applyLineReset(line), width);

/**
 * From the rendered rows to the rows the terminal gets: fake cursors resolved (so overlays and line slicing see plain
 * SGR codes), overlays composited, the cursor position extracted, then line resets and clipping. Without overlays the
 * rows go through one pass that reads only what changed since the last frame; with overlays they go through the
 * row-by-row memories of each step.
 */
export class FrameFinisher {
	private readonly frameRows = new FrameRows(finishRow);
	private readonly cursorRows = new CursorRows();
	private readonly finishedLines = new FinishedLines(finishRow);
	private lastSource: RowSource | undefined;
	private lastPath: "plain" | "overlay" | undefined;
	private lastOutput: readonly string[] | undefined;

	finish(
		source: RowSource,
		showHardwareCursor: boolean,
		width: number,
		height: number,
		overlays: ((lines: string[]) => string[]) | undefined,
	): FinishedFrame {
		const lastSource = this.lastSource;
		const lastPath = this.lastPath;
		const previous = this.lastOutput;
		const shared = sharedRowsOf(lastSource, source);
		let frame: { lines: string[]; cursor: { row: number; col: number } | null; unchanged: number };
		if (overlays) {
			const lines = isRowFrame(source) ? frameLines(source) : source;
			const resolved = this.cursorRows.resolveFrom(
				lines,
				showHardwareCursor,
				height,
				overlays,
				lastPath === "overlay" ? shared : 0,
			);
			const finished = this.finishedLines.applyFrom(resolved.lines, width, resolved.unchanged);
			frame = {
				lines: finished.lines,
				cursor: resolved.cursor,
				unchanged: lastPath === "overlay" ? finished.unchanged : 0,
			};
			this.lastPath = "overlay";
		} else {
			frame = this.frameRows.apply(source, showHardwareCursor, width, height, { from: lastSource, rows: shared });
			if (lastPath !== "plain") frame.unchanged = 0;
			this.lastPath = "plain";
		}
		this.lastSource = source;
		this.lastOutput = frame.lines;
		return { ...frame, previous };
	}
}
