import type { Terminal } from "../terminal.ts";
import { FinishedLines, finishScreenRow } from "../tui/clip.ts";
import { FrameCursorMemo, ImageRowsMemo, renderAltScreenOutput } from "./frame.ts";
import type { AltScreenImages } from "./images.ts";
import { TrimmedRowsMemo } from "./scroll-shift.ts";

/** What the terminal shows after the last frame, and the memos that let the next frame rewrite only what changed. */
export class AltScreenPainter {
	screen: string[] = [];
	width = 0;
	height = 0;
	readonly finishedLines = new FinishedLines(finishScreenRow);
	private readonly trimmedRows = new TrimmedRowsMemo();
	private readonly imageRows = new ImageRowsMemo();
	private readonly cursorMemo = new FrameCursorMemo();

	/** The next frame paints whole. */
	reset(): void {
		this.screen = [];
		this.width = 0;
		this.height = 0;
		this.cursorMemo.reset();
		this.finishedLines.reset();
	}

	/** Diff `screen` against the last frame, build its output and remember it as the screen. */
	paint(
		screen: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
		terminal: Terminal,
		images: AltScreenImages,
		showHardwareCursor: boolean,
	): { buffer: string; fullRedraw: boolean; imagesRedrawn: boolean } {
		const result = renderAltScreenOutput({
			screen,
			previousScreen: this.screen,
			previousScreenWidth: this.width,
			previousScreenHeight: this.height,
			width,
			height,
			imageProtocol: images.protocol,
			uploadedKittyImages: images.uploaded,
			cursorPos,
			showHardwareCursor,
			trimmedRows: this.trimmedRows,
			imageRowsMemo: this.imageRows,
			cursorMemo: this.cursorMemo,
			synchronized: terminal.synchronizedOutput === true,
		});
		this.screen = screen;
		this.width = width;
		this.height = height;
		return result;
	}
}
