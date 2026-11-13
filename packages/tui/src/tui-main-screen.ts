import { hasTmuxSession } from "./multiplexer.ts";
import { BEGIN_SYNCHRONIZED_OUTPUT, END_SYNCHRONIZED_OUTPUT } from "./terminal/sequences.ts";
import { isImageLine } from "./terminal-image.ts";
import { renderRowFrame } from "./tui/container-walk.ts";
import { LayoutRecorder, recordLayout } from "./tui/layout-recorder.ts";
import type { RenderCounters } from "./tui/render-counters.ts";
import { type Component, type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { writeRedrawLog, writeRenderDebugLog } from "./tui-main-screen/debug-logs.ts";
import { FrameFinisher } from "./tui-main-screen/frame-finish.ts";
import { writeChangedRows, writeDeletedRows } from "./tui-main-screen/frame-write.ts";
import {
	collectKittyImageIds,
	deleteKittyImages,
	KittyImageRowCache,
	type KittyImageRows,
} from "./tui-main-screen/kitty-images.ts";
import { findChangedLineRange, type TuiMainScreenRenderState } from "./tui-main-screen/render-diff.ts";
import { appendFullRenderLines, cursorMoveSequence } from "./tui-main-screen/render-output.ts";
import { DEFAULT_REPLAY_ROWS, replayTail, ScrollbackPolicy } from "./tui-main-screen/scrollback.ts";
import { BoundedTerminalWriter } from "./tui-main-screen/terminal-writer.ts";

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	/** Cursor resolution, overlays, resets and clipping of the rows, once per changed row. */
	private readonly finisher = new FrameFinisher();
	private previousKittyImageIds = new Set<number>();
	private readonly kittyRows = new KittyImageRowCache();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	/** The last frame's layout: start rows of its components. */
	private componentLayout: LayoutRecorder | undefined;
	private readonly scrollback = new ScrollbackPolicy();
	/** Rows a replay writes at most; 0 writes all of them. */
	private replayRows = DEFAULT_REPLAY_ROWS;

	get renderCounters(): Readonly<RenderCounters> {
		return this.ledger.snapshot(this.fullRedrawCount);
	}

	isAboveViewport(component: Component): boolean {
		const start = this.componentLayout?.starts.get(component);
		return start !== undefined && start < this.previousViewportTop;
	}

	setReplayRows(rows: number): void {
		this.replayRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
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
		const viewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;

		// Render the rows (as a row frame: the transcript is not joined into a new array), then finish them for the
		// terminal: all before the differential compare.
		const layout = new LayoutRecorder();
		const source = recordLayout(layout, () => renderRowFrame(this, width) ?? this.render(width));
		this.componentLayout = layout;
		const previousLayout = this.scrollback.advance(layout);
		const repaintRequested = this.ledger.takeRepaint();
		const overlays = this.hasOverlayEntries
			? (lines: string[]) => this.compositeOverlays(lines, width, height)
			: undefined;
		const frame = this.finisher.finish(source, this.getShowHardwareCursor(), width, height, overlays);
		const cursorPos = frame.cursor;
		const newLines = frame.lines;
		// Every pass below starts at the first row that can differ from the rows on the terminal: those above it are the
		// same strings when the terminal shows the last frame's rows.
		const sharedRows = this.previousLines === frame.previous ? frame.unchanged : 0;
		const previousImageRows = this.kittyRows.of(this.previousLines);
		const imageRows = this.kittyRows.of(
			newLines,
			frame.previous ? { from: frame.previous, unchanged: frame.unchanged } : undefined,
		);
		const commit = { newLines, imageRows, width, height, cursorPos };

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = this.createWriter();
			output.append(BEGIN_SYNCHRONIZED_OUTPUT);
			if (clear) {
				output.append(deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			appendFullRenderLines(
				output,
				clear ? replayTail(newLines, this.replayRows, height) : newLines,
				height,
				hasTmuxSession(),
			);
			output.append(END_SYNCHRONIZED_OUTPUT);
			this.flush(output);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			this.maxLinesRendered = clear ? newLines.length : Math.max(this.maxLinesRendered, newLines.length);
			const bufferLength = Math.max(height, newLines.length);
			this.commitFrame({ ...commit, viewportTop: Math.max(0, bufferLength - height) });
		};

		const redrawLogDirectory = process.env.OCTOCODE_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const replay = (reason: string): void => {
			writeRedrawLog(redrawLogDirectory, reason, this.previousLines.length, newLines.length, height);
			fullRender(true);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			writeRedrawLog(redrawLogDirectory, "first render", this.previousLines.length, newLines.length, height);
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) return replay(`terminal width changed (${this.previousWidth} -> ${width})`);

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !process.env.TERMUX_VERSION) {
			return replay(`terminal height changed (${this.previousHeight} -> ${height})`);
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			return replay(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
		}

		const bothImageRows = { previous: previousImageRows, next: imageRows };
		let range = findChangedLineRange(this.previousLines, newLines, sharedRows, bothImageRows);
		// Scrollback cannot be edited: rows that changed in place above the viewport are left as the terminal has them.
		const deferred =
			range.firstChanged !== -1 &&
			range.firstChanged < viewportTop &&
			this.scrollback.canDefer({
				previousLayout,
				layout,
				previousLines: this.previousLines,
				newLines,
				viewportTop,
				repaintRequested,
				firstChanged: range.firstChanged,
			});
		if (deferred)
			range = findChangedLineRange(this.previousLines, newLines, Math.max(viewportTop, sharedRows), bothImageRows);
		const { firstChanged, lastChanged, appendedLines } = range;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			if (deferred) {
				this.ledger.counters.deferredAboveViewport += 1;
				this.previousLines = newLines;
			} else if (newLines.length === this.previousLines.length) {
				// Row for row the same strings: keeping the new array lets the next frame start where this one changed.
				this.previousLines = newLines;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = viewportTop;
			this.previousHeight = height;
			return;
		}

		const change = {
			previousLines: this.previousLines,
			newLines,
			firstChanged,
			lastChanged,
			previousImageRows,
			hardwareCursorRow: this.hardwareCursorRow,
			viewportTop,
			height,
		};

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = this.createWriter();
				const written = writeDeletedRows(output, change);
				if ("replay" in written) return replay(written.replay);
				this.flush(output);
				this.cursorRow = written.cursorRow;
				this.hardwareCursorRow = written.cursorRow;
			}
			this.commitFrame({ ...commit, viewportTop });
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < viewportTop) return replay(`firstChanged < viewportTop (${firstChanged} < ${viewportTop})`);

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = this.createWriter();
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;
		const written = writeChangedRows(output, { ...change, appendStart });
		if ("replay" in written) return replay(written.replay);

		if (process.env.OCTOCODE_TUI_DEBUG === "1") {
			writeRenderDebugLog({
				firstChanged,
				viewportTop: written.viewportTop,
				cursorRow: this.cursorRow,
				height,
				lineDiff: written.lineDiff,
				hardwareCursorRow: written.hardwareCursorRow,
				renderEnd: written.renderEnd,
				finalCursorRow: written.cursorRow,
				cursorPos,
				newLines,
				previousLines: this.previousLines,
				outputLength: output.length,
			});
		}

		this.flush(output);
		if (deferred) this.ledger.counters.deferredAboveViewport += 1;

		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = written.cursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.commitFrame({ ...commit, viewportTop: Math.max(written.viewportTop, written.cursorRow - height + 1) });
	}

	private createWriter(): BoundedTerminalWriter {
		return new BoundedTerminalWriter((data) => this.terminal.write(data));
	}

	private flush(output: BoundedTerminalWriter): void {
		output.flush();
		this.ledger.counters.written += 1;
	}

	/** Place the hardware cursor and remember what the terminal now shows, for the next frame's compare. */
	private commitFrame(frame: {
		newLines: string[];
		imageRows: KittyImageRows;
		width: number;
		height: number;
		cursorPos: { row: number; col: number } | null;
		viewportTop: number;
	}): void {
		this.positionHardwareCursor(frame.cursorPos, frame.newLines.length);
		this.previousLines = frame.newLines;
		this.previousKittyImageIds = collectKittyImageIds(frame.newLines, frame.imageRows);
		this.previousWidth = frame.width;
		this.previousHeight = frame.height;
		this.previousViewportTop = frame.viewportTop;
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
