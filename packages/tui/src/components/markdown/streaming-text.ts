import type { Component } from "../../tui.ts";
import { renderChanged, trackRenderChanges } from "../../tui/render-signal.ts";
import { softWrapSpaceMark } from "../../utils/row-marks.ts";
import { flattenLines, wrapTextWithAnsi } from "../../utils/wrap.ts";
import { fitHorizontalPadding, frameContentRows } from "../../utils.ts";

/**
 * The framed rows of a source's finished lines (all text up to its last line break) at one width, with the soft-wrap
 * mark of the render that wrapped them (scroll-view content marks rows broken at a space).
 */
interface Settled {
	width: number;
	mark: string;
	source: string;
	rows: string[];
}

/**
 * Markdown source shown as plain wrapped text while it streams: no lexing, no Markdown rendering. An append re-wraps
 * only the text after the last line break it had already wrapped, so a frame costs the length of the unfinished line,
 * not of the reply. Render the finished text with `Markdown`.
 */
export class StreamingText implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly style: ((line: string) => string) | undefined;
	private readonly transform: ((text: string, availableWidth: number) => string) | undefined;
	private settled: Settled | undefined;
	private cached: { text: string; width: number; mark: string; lines: string[] } | undefined;

	/**
	 * `style` colours each source line before it wraps; `transform` maps the source (for example, sanitizes it) with the
	 * width available for content, and the result is wrapped.
	 */
	constructor(
		text: string,
		paddingX: number,
		style?: (line: string) => string,
		transform?: (text: string, availableWidth: number) => string,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.style = style;
		this.transform = transform;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.cached = undefined;
		renderChanged(this);
	}

	invalidate(): void {
		this.settled = undefined;
		this.cached = undefined;
		renderChanged(this);
	}

	render(width: number): string[] {
		const mark = softWrapSpaceMark();
		if (this.cached?.text === this.text && this.cached.width === width && this.cached.mark === mark)
			return this.cached.lines;
		const paddingX = fitHorizontalPadding(width, this.paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const source = (this.transform?.(this.text, contentWidth) ?? this.text).replace(/\t/g, "   ");
		const wrap = (text: string): string[] =>
			frameContentRows(
				text
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(this.style && line ? this.style(line) : line, contentWidth)),
				width,
				paddingX,
			);
		let lines: string[];
		if (!source.trim()) lines = [];
		else {
			let settled = this.settled;
			if (!settled || settled.width !== width || settled.mark !== mark || !source.startsWith(settled.source))
				settled = { width, mark, source: "", rows: [] };
			const end = source.lastIndexOf("\n") + 1;
			if (end > settled.source.length) {
				const added = wrap(source.slice(settled.source.length, end - 1));
				flattenLines(added);
				for (const row of added) settled.rows.push(row);
				settled.source = source.slice(0, end);
			}
			this.settled = settled;
			lines = settled.rows.concat(wrap(source.slice(end)));
		}
		this.cached = { text: this.text, width, mark, lines };
		return lines;
	}
}

trackRenderChanges(StreamingText.prototype);
