import { type Component, renderChanged, trackRenderChanges, truncateToVisualLines } from "@octocodeai/octocode-tui";
import { formatDuration } from "../../../utils/duration.ts";

/** The run time field of a result header: `4.2s`, `61s`. */
const SECONDS = /^(\d+(?:\.\d+)?)s$/;
/** A path the header names (`full output: <path>`, `saved output: <path> (…)`). */
const SAVED_PATH = /(?:full|saved) output: (\S+)/;

/**
 * A result header (`[exit 0 · 4.2s · 312 lines · 18 KB]`) split for the row: the outcome words without the brackets
 * and the run time, the run time for the title (from 1s on, as on a tool row), and the saved-output path to link.
 */
export function outcomeParts(header: string): { text: string; time?: string; path?: string } {
	const fields = header.replace(/^\[/, "").replace(/\]$/, "").split(" · ");
	const seconds = fields.length > 1 ? SECONDS.exec(fields[1]) : null;
	if (seconds) fields.splice(1, 1);
	const ms = seconds ? Number(seconds[1]) * 1000 : 0;
	const text = fields.join(" · ");
	const path = SAVED_PATH.exec(text)?.[1];
	return { text, ...(ms >= 1000 ? { time: formatDuration(ms, true) } : {}), ...(path ? { path } : {}) };
}

/** Last `maxLines` non-trailing-empty lines from `tailLines` + `currentLine`, without joining the whole buffer. */
export function sliceRunningPreview(
	tailLines: readonly string[],
	currentLine: string,
	maxLines: number,
	droppedLines: number,
): { lines: string[]; hiddenCount: number } {
	let total = tailLines.length + (currentLine ? 1 : 0);
	if (!currentLine) {
		while (total > 0 && tailLines[total - 1] === "") total--;
	}
	const start = Math.max(0, total - maxLines);
	const lines: string[] = [];
	for (let i = start; i < total; i++) lines.push(i < tailLines.length ? tailLines[i] : currentLine);
	return { lines, hiddenCount: droppedLines + total - lines.length };
}

/** The last lines of a command's output, cut to `maxLines` visual rows per width. */
export class OutputPreview implements Component {
	private text: string;
	private readonly maxLines: number;
	private pad: number;
	private cached?: { width: number; lines: string[] };

	constructor(text: string, maxLines: number, pad: number) {
		this.text = text;
		this.maxLines = maxLines;
		this.pad = pad;
	}

	setText(text: string, pad = this.pad): void {
		if (text === this.text && pad === this.pad) return;
		this.text = text;
		this.pad = pad;
		this.cached = undefined;
		renderChanged(this);
	}

	invalidate(): void {
		this.cached = undefined;
		renderChanged(this);
	}

	render(width: number): string[] {
		if (this.cached?.width !== width) {
			this.cached = { width, lines: truncateToVisualLines(this.text, this.maxLines, width, this.pad).visualLines };
		}
		return this.cached.lines;
	}
}
trackRenderChanges(OutputPreview.prototype);
