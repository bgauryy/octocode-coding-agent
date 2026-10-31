import type { Token } from "marked";
import { isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { wrapTextWithAnsi } from "../utils/wrap.ts";
import { frameContentLines } from "../utils.ts";
import { renderToken } from "./markdown/blocks.ts";
import { type LexedMarkdown, lexMarkdown } from "./markdown/incremental.ts";
import type {
	DefaultTextStyle,
	InlineStyleContext,
	MarkdownOptions,
	MarkdownRenderHost,
	MarkdownTheme,
} from "./markdown/types.ts";

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	// Parsed tokens depend only on the source, so they survive theme and width invalidation. Held weakly: a token tree is
	// about ten times the size of its source, and every message of a long transcript keeps a Markdown component. The
	// tokens survive a burst of re-renders, such as a theme preview, and are collected afterwards.
	private cachedTokens?: WeakRef<LexedMarkdown>;
	// Rendered and wrapped rows of each top-level token, so a streamed update re-renders only the blocks it changed.
	// Rows depend on the theme, the default style and the width: `invalidate` clears them, a new width replaces them.
	private blockRows = new WeakMap<Token, { width: number; nextType: string | undefined; rows: string[] }>();
	private blockRowsWidth = 0;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.clearOutput();
	}

	invalidate(): void {
		this.clearOutput();
		this.blockRows = new WeakMap();
	}

	private clearOutput(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = text.replace(/\t/g, "   ");

		// Parse markdown to tokens, keeping those of blocks that an appended update cannot change
		const previous = this.cachedTokens?.deref();
		const lexed = previous?.source === normalizedText ? previous : lexMarkdown(normalizedText, previous);
		this.cachedTokens = new WeakRef(lexed);
		const tokens = lexed.tokens;

		// Convert tokens to styled terminal output, then wrap (NO padding, NO background yet)
		if (this.blockRowsWidth !== contentWidth) {
			this.blockRows = new WeakMap();
			this.blockRowsWidth = contentWidth;
		}
		const host = this.renderHost();
		const wrappedLines: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextType = tokens[i + 1]?.type;
			let entry = this.blockRows.get(token);
			if (!entry || entry.width !== contentWidth || entry.nextType !== nextType) {
				const rows: string[] = [];
				for (const line of renderToken(host, token, contentWidth, nextType)) {
					if (isImageLine(line)) rows.push(line);
					else rows.push(...wrapTextWithAnsi(line, contentWidth));
				}
				entry = { width: contentWidth, nextType, rows };
				this.blockRows.set(token, entry);
			}
			for (const row of entry.rows) wrappedLines.push(row);
		}

		const result = frameContentLines(
			wrappedLines,
			width,
			this.paddingX,
			this.paddingY,
			this.defaultTextStyle?.bgColor,
			isImageLine,
		);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		const styled = this.applyDefaultStyle(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	/** The component's theme, options and default style, as the token renderers read them. */
	private renderHost(): MarkdownRenderHost {
		return {
			theme: this.theme,
			options: this.options,
			applyDefaultStyle: (text: string) => this.applyDefaultStyle(text),
			getDefaultInlineStyleContext: () => this.getDefaultInlineStyleContext(),
		};
	}
}
