import { hasTmuxSession } from "./multiplexer.ts";
import { isImageLine } from "./terminal-image.ts";
import { clipLineToWidth, FinishedLines } from "./tui/clip.ts";
import { applyLineReset } from "./tui/composite.ts";
import { LayoutRecorder, recordLayout } from "./tui/layout-recorder.ts";
import type { RenderCounters } from "./tui/render-counters.ts";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { writeRedrawLog, writeRenderDebugLog } from "./tui-main-screen/debug-logs.ts";
import { collectKittyImageIds, deleteChangedKittyImages, deleteKittyImages } from "./tui-main-screen/kitty-images.ts";
import { findChangedLineRange, type TuiMainScreenRenderState } from "./tui-main-screen/render-diff.ts";
import {
	appendChangedRows,
	appendClearedExtraLines,
	appendFullRenderLines,
	cursorMoveSequence,
} from "./tui-main-screen/render-output.ts";
import { ScrollbackPolicy } from "./tui-main-screen/scrollback.ts";
import { BoundedTerminalWriter } from "./tui-main-screen/terminal-writer.ts";

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	/** Resets and clipping of the rows, once per changed row. */
	private readonly finishedLines = new FinishedLines((line, width) => clipLineToWidth(applyLineReset(line), width));
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private readonly scrollback = new ScrollbackPolicy();

	get renderCounters(): Readonly<RenderCounters> {
		return this.ledger.snapshot(this.fullRedrawCount);
	}

	/** Replay the whole transcript if a row above the viewport changed (default: left alone; `invalidate` asks too). */
	repaintScrollback(): void {
		this.ledger.askRepaint();
		this.requestRender();
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
		this.scrollback.reset();
	}

	protected override renderedLines(): readonly string[] {
		return this.previousLines;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.scrollback.reset();
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		// Resolve fake cursors before compositing so overlays and line slicing see plain SGR codes
		const layout = new LayoutRecorder();
		let newLines = this.resolveFakeCursors(recordLayout(layout, () => this.render(width)));
		const previousLayout = this.scrollback.advance(layout.leaves);
		const repaintRequested = this.ledger.takeRepaint();

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		// A row wider than the terminal would wrap and shift every row below it, in the full render and the diff alike.
		newLines = this.finishedLines.apply(newLines, width);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (clear) {
				output.append(deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			appendFullRenderLines(output, newLines, height, hasTmuxSession());
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			this.ledger.counters.written += 1;
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory = process.env.OCTOCODE_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void =>
			writeRedrawLog(redrawLogDirectory, reason, this.previousLines.length, newLines.length, height);

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		let range = findChangedLineRange(this.previousLines, newLines);
		// Scrollback cannot be edited: rows that changed in place above the viewport are left as the terminal has them.
		const deferred =
			range.firstChanged !== -1 &&
			range.firstChanged < prevViewportTop &&
			this.scrollback.canDefer({
				previousLayout,
				layout: layout.leaves,
				previousLines: this.previousLines,
				newLines,
				viewportTop: prevViewportTop,
				repaintRequested,
			});
		if (deferred) range = findChangedLineRange(this.previousLines, newLines, prevViewportTop);
		const { firstChanged, lastChanged, appendedLines } = range;
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			if (deferred) {
				this.ledger.counters.deferredAboveViewport += 1;
				this.previousLines = newLines;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(deleteChangedKittyImages(this.previousLines, firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				appendClearedExtraLines(output, extraLines, newLines.length);
				output.append("\x1b[?2026l");
				output.flush();
				this.ledger.counters.written += 1;
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(deleteChangedKittyImages(this.previousLines, firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		const replayReason = appendChangedRows(output, {
			newLines,
			previousLines: this.previousLines,
			firstChanged,
			renderEnd,
			viewportTop,
			height,
		});
		if (replayReason) {
			logRedraw(replayReason);
			fullRender(true);
			return;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			output.append(`\x1b[${extraLines}A`);
		}

		output.append("\x1b[?2026l"); // End synchronized output

		if (process.env.OCTOCODE_TUI_DEBUG === "1") {
			writeRenderDebugLog({
				firstChanged,
				viewportTop,
				cursorRow: this.cursorRow,
				height,
				lineDiff,
				hardwareCursorRow,
				renderEnd,
				finalCursorRow,
				cursorPos,
				newLines,
				previousLines: this.previousLines,
				outputLength: output.length,
			});
		}

		output.flush();
		this.ledger.counters.written += 1;
		if (deferred) this.ledger.counters.deferredAboveViewport += 1;

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/** Move the hardware cursor to the IME position, or hide it when there is none. */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const buffer = cursorMoveSequence(targetRow - this.hardwareCursorRow, Math.max(0, cursorPos.col));
		if (buffer) this.terminal.write(buffer);
		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) this.terminal.showCursor();
		else this.terminal.hideCursor();
	}
}
