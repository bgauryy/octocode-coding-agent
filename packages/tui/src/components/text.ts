import type { Component } from "../tui.ts";
import { renderChanged, trackRenderChanges } from "../tui/render-signal.ts";
import { visibleWidth } from "../utils/width.ts";
import { wrapTextWithAnsi } from "../utils/wrap.ts";
import { fitHorizontalPadding, frameContentLines } from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;
	private hangingIndent = false;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		renderChanged(this);
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		renderChanged(this);
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidate();
	}

	/** Wrapped continuation rows keep the leading spaces of the line they continue, e.g. an indented list of names. */
	setHangingIndent(hangingIndent: boolean): void {
		this.hangingIndent = hangingIndent;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		renderChanged(this);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Reduce margins when necessary so content and padding fit within the available width.
		const paddingX = fitHorizontalPadding(width, this.paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = this.hangingIndent
			? normalizedText.split("\n").flatMap((line) => wrapWithHangingIndent(line, contentWidth))
			: wrapTextWithAnsi(normalizedText, contentWidth);

		const result = frameContentLines(wrappedLines, width, paddingX, this.paddingY, this.customBgFn);

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}

trackRenderChanges(Text.prototype);

/** Leading SGR sequences, then the leading spaces of the visible text. */
const LEADING_INDENT = /^((?:\x1b\[[0-9;]*m)*)( +)/;
/** Leading SGR sequences, then one marker glyph (`⚠`, `•`, `✗`) and one space; the text starts after them. */
const LEADING_MARKER = /^(?:\x1b\[[0-9;]*m)*([^\s\w\x1b][\uFE0E\uFE0F]?)(?:\x1b\[[0-9;]*m)* (?=\S)/u;

/** The continuation indent of `line`: its leading spaces, else the width of a leading glyph marker and its space. */
function hangingIndentOf(line: string): string {
	const spaces = line.match(LEADING_INDENT)?.[2];
	if (spaces) return spaces;
	const marker = line.match(LEADING_MARKER)?.[1];
	return marker ? " ".repeat(visibleWidth(marker) + 1) : "";
}

function wrapWithHangingIndent(line: string, width: number): string[] {
	const indent = hangingIndentOf(line);
	const [first = "", ...rest] = wrapTextWithAnsi(line, width);
	if (rest.length === 0 || indent.length === 0 || indent.length >= width / 2) return [first, ...rest];
	// Re-wrap what follows the first row in the room the indent leaves.
	const continued = wrapTextWithAnsi(rest.join(" "), width - indent.length);
	return [first, ...continued.map((part) => indent + part)];
}
