import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "../utils.ts";

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

/** Log all rendered lines to the crash file for debugging; returns the file's path. */
export function writeWidthCrashLog(
	logDirectory: string | undefined,
	width: number,
	i: number,
	line: string,
	newLines: string[],
): string {
	const crashLogPath = path.join(logDirectory ?? os.tmpdir(), "octocode-tui-crash.log");
	const crashData = [
		`Crash at ${new Date().toISOString()}`,
		`Terminal width: ${width}`,
		`Line ${i} visible width: ${visibleWidth(line)}`,
		"",
		"=== All rendered lines ===",
		...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
		"",
	].join("\n");
	fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
	fs.writeFileSync(crashLogPath, crashData);
	return crashLogPath;
}

/** Describe rendered line `i`, wider than the terminal, and point to the crash log. */
export function widthErrorMessage(i: number, line: string, width: number, crashLogPath: string): string {
	const errorMsg = [
		`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
		"",
		"This is likely caused by a custom TUI component not truncating its output.",
		"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
		"",
		`Debug log written to: ${crashLogPath}`,
	].join("\n");
	return errorMsg;
}

/** Values of one differential render, dumped when OCTOCODE_TUI_DEBUG=1. */
export interface RenderDebugState {
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
