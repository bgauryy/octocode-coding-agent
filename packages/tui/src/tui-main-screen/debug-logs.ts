import * as fs from "node:fs";
import * as path from "node:path";

/** Append one full-redraw reason to the debug log when OCTOCODE_TUI_DEBUG_REDRAW=1 gave a directory. */
export function writeRedrawLog(
	redrawLogDirectory: string | undefined,
	reason: string,
	previousLineCount: number,
	newLineCount: number,
	height: number,
): void {
	if (redrawLogDirectory === undefined) return;
	const logPath = path.join(redrawLogDirectory, "octocode-tui-debug.log");
	const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${previousLineCount}, new=${newLineCount}, height=${height})\n`;
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.appendFileSync(logPath, msg);
}

/** Values of one differential render, dumped when OCTOCODE_TUI_DEBUG=1. */
interface RenderDebugState {
	firstChanged: number;
	viewportTop: number;
	cursorRow: number;
	height: number;
	lineDiff: number;
	hardwareCursorRow: number;
	renderEnd: number;
	finalCursorRow: number;
	cursorPos: { row: number; col: number } | null;
	newLines: string[];
	previousLines: string[];
	outputLength: number;
}

/** Write one differential render's state and lines to a file under /tmp/tui. */
export function writeRenderDebugLog(state: RenderDebugState): void {
	const {
		firstChanged,
		viewportTop,
		cursorRow,
		height,
		lineDiff,
		hardwareCursorRow,
		renderEnd,
		finalCursorRow,
		cursorPos,
		newLines,
		previousLines,
		outputLength,
	} = state;
	const debugDir = "/tmp/tui";
	fs.mkdirSync(debugDir, { recursive: true });
	const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
	const debugData = [
		`firstChanged: ${firstChanged}`,
		`viewportTop: ${viewportTop}`,
		`cursorRow: ${cursorRow}`,
		`height: ${height}`,
		`lineDiff: ${lineDiff}`,
		`hardwareCursorRow: ${hardwareCursorRow}`,
		`renderEnd: ${renderEnd}`,
		`finalCursorRow: ${finalCursorRow}`,
		`cursorPos: ${JSON.stringify(cursorPos)}`,
		`newLines.length: ${newLines.length}`,
		`previousLines.length: ${previousLines.length}`,
		"",
		"=== newLines ===",
		JSON.stringify(newLines, null, 2),
		"",
		"=== previousLines ===",
		JSON.stringify(previousLines, null, 2),
		"",
		"=== buffer ===",
		`[${outputLength} chars written in bounded chunks]`,
	].join("\n");
	fs.writeFileSync(debugPath, debugData);
}
