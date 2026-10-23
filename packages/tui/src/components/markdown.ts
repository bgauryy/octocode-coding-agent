import type { Token } from "marked";
import { isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { renderToken } from "./markdown/blocks.ts";
import { markdownParser, trimPartialClosingFences } from "./markdown/parser.ts";
import type {
	DefaultTextStyle,
	InlineStyleContext,
	MarkdownOptions,
	MarkdownRenderHost,
	MarkdownTheme,
} from "./markdown/types.ts";

export type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "./markdown/types.ts";

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
	private cachedTokens?: WeakRef<{ source: string; tokens: Token[] }>;

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
		this.invalidate();
	}

	invalidate(): void {
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

		// Parse markdown to HTML-like tokens
		const cached = this.cachedTokens?.deref();
		let tokens = cached?.source === normalizedText ? cached.tokens : undefined;
		if (!tokens) {
			tokens = markdownParser.lexer(normalizedText);
			trimPartialClosingFences(tokens);
			this.cachedTokens = new WeakRef({ source: normalizedText, tokens });
		}

		// Convert tokens to styled terminal output
		const host = this.renderHost();
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = renderToken(host, token, contentWidth, nextToken?.type);
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);
		flattenLines(result);

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
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

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
