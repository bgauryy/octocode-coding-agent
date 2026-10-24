import type { Token } from "marked";
import { renderLatex } from "../../latex.ts";
import { getCapabilities } from "../../terminal-image/capabilities.ts";
import { hyperlink } from "../../terminal-image.ts";
import type { LatexToken } from "./parser.ts";
import type { InlineStyleContext, MarkdownRenderHost } from "./types.ts";

export function renderInlineTokens(
	host: MarkdownRenderHost,
	tokens: Token[],
	styleContext?: InlineStyleContext,
): string {
	let result = "";
	const resolvedStyleContext = styleContext ?? host.getDefaultInlineStyleContext();
	const { applyText, stylePrefix } = resolvedStyleContext;
	const applyTextWithNewlines = (text: string): string => {
		const segments: string[] = text.split("\n");
		return segments.map((segment: string) => applyText(segment)).join("\n");
	};

	for (const token of tokens) {
		switch (token.type) {
			case "latex": {
				const latexToken = token as LatexToken;
				const rendered =
					!latexToken.pending && host.options.renderLatex !== false
						? (renderLatex(latexToken.text) ?? latexToken.raw)
						: latexToken.raw;
				result += applyTextWithNewlines(rendered);
				break;
			}

			case "escape":
				result += applyTextWithNewlines(host.options.preserveBackslashEscapes ? token.raw : token.text);
				break;

			case "text":
				// Text tokens in list items can have nested tokens for inline formatting
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(host, token.tokens, resolvedStyleContext);
				} else {
					result += applyTextWithNewlines(token.text);
				}
				break;

			case "paragraph":
				// Paragraph tokens contain nested inline tokens
				result += renderInlineTokens(host, token.tokens || [], resolvedStyleContext);
				break;

			case "strong": {
				const boldContent = renderInlineTokens(host, token.tokens || [], resolvedStyleContext);
				result += host.theme.bold(boldContent) + stylePrefix;
				break;
			}

			case "em": {
				const italicContent = renderInlineTokens(host, token.tokens || [], resolvedStyleContext);
				result += host.theme.italic(italicContent) + stylePrefix;
				break;
			}

			case "codespan":
				result += host.theme.code(token.text) + stylePrefix;
				break;

			case "link": {
				const linkText = renderInlineTokens(host, token.tokens || [], resolvedStyleContext);
				const styledLink = host.theme.link(host.theme.underline(linkText));
				if (getCapabilities().hyperlinks) {
					// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
					// so we always show only the link text regardless of whether it matches href.
					result += hyperlink(styledLink, token.href) + stylePrefix;
				} else {
					// Fallback: print URL in parentheses when text differs from href.
					// Compare raw token.text (not styled) against href for the equality check.
					// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
					// but href="mailto:foo@bar.com").
					const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
					if (token.text === token.href || token.text === hrefForComparison) {
						result += styledLink + stylePrefix;
					} else {
						result += styledLink + host.theme.linkUrl(` (${token.href})`) + stylePrefix;
					}
				}
				break;
			}

			case "br":
				result += "\n";
				break;

			case "del": {
				const delContent = renderInlineTokens(host, token.tokens || [], resolvedStyleContext);
				result += host.theme.strikethrough(delContent) + stylePrefix;
				break;
			}

			case "html":
				// Render inline HTML as plain text
				if ("raw" in token && typeof token.raw === "string") {
					result += applyTextWithNewlines(token.raw);
				}
				break;

			default:
				// Handle any other inline token types as plain text
				if ("text" in token && typeof token.text === "string") {
					result += applyTextWithNewlines(token.text);
				}
		}
	}

	while (stylePrefix && result.endsWith(stylePrefix)) {
		result = result.slice(0, -stylePrefix.length);
	}

	return result;
}
