import type { Token, Tokens } from "marked";
import { renderLatex } from "../../latex.ts";
import { wrapTextWithAnsi } from "../../utils/wrap.ts";
import { visibleWidth } from "../../utils/width.ts";
import { renderInlineTokens } from "./inline.ts";
import type { LatexToken } from "./parser.ts";
import { renderTable } from "./table.ts";
import type { InlineStyleContext, MarkdownRenderHost } from "./types.ts";

function getStylePrefix(styleFn: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = styleFn(sentinel);
	const sentinelIndex = styled.indexOf(sentinel);
	return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
}

export function renderToken(
	host: MarkdownRenderHost,
	token: Token,
	width: number,
	nextTokenType?: string,
	styleContext?: InlineStyleContext,
): string[] {
	const lines: string[] = [];

	switch (token.type) {
		case "heading": {
			const headingLevel = token.depth;
			const headingPrefix = `${"#".repeat(headingLevel)} `;

			// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
			// restore heading styling after their own ANSI resets instead of falling back to
			// the default text style.
			let headingStyleFn: (text: string) => string;
			if (headingLevel === 1) {
				headingStyleFn = (text: string) => host.theme.heading(host.theme.bold(host.theme.underline(text)));
			} else {
				headingStyleFn = (text: string) => host.theme.heading(host.theme.bold(text));
			}

			const headingStyleContext: InlineStyleContext = {
				applyText: headingStyleFn,
				stylePrefix: getStylePrefix(headingStyleFn),
			};

			const headingText = renderInlineTokens(host, token.tokens ?? [], headingStyleContext);
			const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
			lines.push(styledHeading);
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after headings (unless space token follows)
			}
			break;
		}

		case "paragraph": {
			const paragraphText = renderInlineTokens(host, token.tokens ?? [], styleContext);
			lines.push(paragraphText);
			// Don't add spacing if next token is space or list
			if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
				lines.push("");
			}
			break;
		}

		case "text":
			lines.push(renderInlineTokens(host, [token], styleContext));
			break;

		case "latexBlock": {
			const latexToken = token as LatexToken;
			const rendered =
				!latexToken.pending && host.options.renderLatex !== false
					? (renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim())
					: latexToken.raw.trim();
			for (const line of rendered.split("\n")) {
				lines.push(host.applyDefaultStyle(line));
			}
			if (nextTokenType && nextTokenType !== "space") {
				lines.push("");
			}
			break;
		}

		case "code": {
			const indent = host.theme.codeBlockIndent ?? "  ";
			lines.push(host.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
			const sourceLines: string[] = token.text.split("\n");
			const styledLines = host.theme.highlightCode
				? host.theme.highlightCode(token.text, token.lang)
				: sourceLines.map((codeLine) => host.theme.codeBlock(codeLine));
			// A long code line wraps here rather than in render()'s final pass, so its continuation rows keep
			// the block indent and the line's own indentation instead of starting at column 0.
			const codeWidth = Math.max(1, width - visibleWidth(indent));
			for (let i = 0; i < styledLines.length; i++) {
				const styledLine = styledLines[i];
				if (visibleWidth(styledLine) <= codeWidth) {
					lines.push(`${indent}${styledLine}`);
					continue;
				}
				const hang = (sourceLines[i]?.match(/^[ \t]*/)?.[0] ?? "").slice(0, Math.floor(codeWidth / 2));
				const [first = "", ...rest] = wrapTextWithAnsi(styledLine, codeWidth);
				lines.push(`${indent}${first}`);
				for (const continuation of rest.flatMap((part) =>
					wrapTextWithAnsi(part, Math.max(1, codeWidth - hang.length)),
				)) {
					lines.push(`${indent}${hang}${continuation}`);
				}
			}
			lines.push(host.theme.codeBlockBorder("```"));
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after code blocks (unless space token follows)
			}
			break;
		}

		case "list": {
			const listLines = renderList(host, token as Tokens.List, 0, width, styleContext);
			lines.push(...listLines);
			// Don't add spacing after lists if a space token follows
			// (the space token will handle it)
			break;
		}

		case "table": {
			const tableLines = renderTable(host, token as Tokens.Table, width, nextTokenType, styleContext);
			lines.push(...tableLines);
			break;
		}

		case "blockquote": {
			const quoteStyle = (text: string) => host.theme.quote(host.theme.italic(text));
			const quoteStylePrefix = getStylePrefix(quoteStyle);
			const applyQuoteStyle = (line: string): string => {
				if (!quoteStylePrefix) {
					return quoteStyle(line);
				}
				const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
				return quoteStyle(lineWithReappliedStyle);
			};

			// Calculate available width for quote content (subtract border "│ " = 2 chars)
			const quoteContentWidth = Math.max(1, width - 2);

			// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
			// children with renderToken() instead of renderInlineTokens().
			// Default message style should not apply inside blockquotes.
			const quoteInlineStyleContext: InlineStyleContext = {
				applyText: (text: string) => text,
				stylePrefix: quoteStylePrefix,
			};
			const quoteTokens = token.tokens ?? [];
			const renderedQuoteLines: string[] = [];
			for (let i = 0; i < quoteTokens.length; i++) {
				const quoteToken = quoteTokens[i];
				const nextQuoteToken = quoteTokens[i + 1];
				renderedQuoteLines.push(
					...renderToken(host, quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
				);
			}

			// Avoid rendering an extra empty quote line before the outer blockquote spacing.
			while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
				renderedQuoteLines.pop();
			}

			for (const quoteLine of renderedQuoteLines) {
				const styledLine = applyQuoteStyle(quoteLine);
				const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
				for (const wrappedLine of wrappedLines) {
					lines.push(host.theme.quoteBorder("│ ") + wrappedLine);
				}
			}
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after blockquotes (unless space token follows)
			}
			break;
		}

		case "hr":
			lines.push(host.theme.hr("─".repeat(Math.min(width, 80))));
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after horizontal rules (unless space token follows)
			}
			break;

		case "html":
			// Render HTML as plain text (escaped for terminal)
			if ("raw" in token && typeof token.raw === "string") {
				lines.push(host.applyDefaultStyle(token.raw.trim()));
			}
			break;

		case "space":
			// Space tokens represent blank lines in markdown
			lines.push("");
			break;

		default:
			// Handle any other token types as plain text
			if ("text" in token && typeof token.text === "string") {
				lines.push(token.text);
			}
	}

	return lines;
}

function getOrderedListMarker(item: Tokens.ListItem): string | undefined {
	const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
	return match ? `${match[1]} ` : undefined;
}

function getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
	const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
	return match ? `${match[1]} ` : undefined;
}

/**
 * Render a list with proper nesting support
 */
function renderList(
	host: MarkdownRenderHost,
	token: Tokens.List,
	depth: number,
	width: number,
	styleContext?: InlineStyleContext,
): string[] {
	const lines: string[] = [];
	const indent = "    ".repeat(depth);
	// Use the list's start property (defaults to 1 for ordered lists)
	const startNumber = typeof token.start === "number" ? token.start : 1;

	for (let i = 0; i < token.items.length; i++) {
		const item = token.items[i];
		const isLastItem = i === token.items.length - 1;
		const bullet = token.ordered
			? host.options.preserveOrderedListMarkers
				? (getOrderedListMarker(item) ?? `${startNumber + i}. `)
				: `${startNumber + i}. `
			: host.options.preserveOrderedListMarkers
				? (getUnorderedListMarker(item) ?? "- ")
				: "- ";
		// Task items read as a checklist: a box glyph replaces the bullet (and follows an ordered number) unless the
		// source markers are preserved.
		const preserve = host.options.preserveOrderedListMarkers;
		const taskMarker = item.task ? (preserve ? `[${item.checked ? "x" : " "}] ` : item.checked ? "✔ " : "☐ ") : "";
		const marker = (item.task && !preserve && !token.ordered ? "" : bullet) + taskMarker;
		const done = item.task && item.checked && !preserve;
		const firstPrefix = indent + host.theme.listBullet(marker);
		const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
		const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
		let renderedAnyLine = false;

		for (const itemToken of item.tokens) {
			if (itemToken.type === "list") {
				lines.push(...renderList(host, itemToken as Tokens.List, depth + 1, width, styleContext));
				renderedAnyLine = true;
				continue;
			}

			const itemLines = renderToken(host, itemToken, itemWidth, undefined, styleContext);
			for (const line of itemLines) {
				for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
					const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
					lines.push(linePrefix + (done && wrappedLine ? host.theme.strikethrough(wrappedLine) : wrappedLine));
					renderedAnyLine = true;
				}
			}
		}

		if (!renderedAnyLine) {
			lines.push(firstPrefix);
		}

		if (token.loose && !isLastItem) {
			lines.push("");
		}
	}

	return lines;
}
