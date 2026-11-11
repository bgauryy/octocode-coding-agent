import type { Token } from "marked";
import { renderLatex } from "../../latex.ts";
import { getCapabilities } from "../../terminal-image/capabilities.ts";
import { hyperlink } from "../../terminal-image.ts";
import { markdownReferenceUrl } from "../../markdown-content.ts";
import { fileReferenceUrl, findFileReferences, splitFileReferences } from "./linkify.ts";
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

	// A file reference is coloured as a link (clickable where the terminal supports it); its text is unchanged.
	const linkifiedText = (text: string, token: Token): string =>
		splitFileReferences(text)
			.map((piece, index) => {
				if (!piece.reference) return applyTextWithNewlines(piece.text);
				const styled = host.theme.link(piece.text);
				const { path, line, column } = piece.reference;
				const url = fileReferenceUrl(path, host.options.cwd ?? process.cwd(), line, column);
				return (
					(getCapabilities().hyperlinks ? hyperlink(styled, url, host.linkId(token, index)) : styled) + stylePrefix
				);
			})
			.join("");

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
					result += linkifiedText(token.text, token);
				}
				break;

			case "paragraph":
				// Paragraph tokens contain nested inline tokens
				result += renderInlineTokens(host, token.tokens ?? [], resolvedStyleContext);
				break;

			case "strong": {
				const boldContent = renderInlineTokens(host, token.tokens ?? [], resolvedStyleContext);
				result += host.theme.bold(boldContent) + stylePrefix;
				break;
			}

			case "em": {
				const italicContent = renderInlineTokens(host, token.tokens ?? [], resolvedStyleContext);
				result += host.theme.italic(italicContent) + stylePrefix;
				break;
			}

			case "codespan": {
				const code = host.theme.code(token.text);
				// A span that is only a file reference becomes a link; the code styling stays.
				const [only] = findFileReferences(token.text);
				const isReference = only !== undefined && only.start === 0 && only.end === token.text.length;
				result +=
					(isReference && getCapabilities().hyperlinks
						? hyperlink(
								code,
								fileReferenceUrl(only.path, host.options.cwd ?? process.cwd(), only.line, only.column),
								host.linkId(token),
							)
						: code) + stylePrefix;
				break;
			}

			case "link": {
				const linkText = renderInlineTokens(host, token.tokens ?? [], resolvedStyleContext);
				const styledLink = host.theme.link(host.theme.underline(linkText));
				const url = markdownReferenceUrl(token.href, host.options.cwd ?? process.cwd());
				if (getCapabilities().hyperlinks && url) {
					// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
					// so we always show only the link text regardless of whether it matches href.
					result += hyperlink(styledLink, url, host.linkId(token)) + stylePrefix;
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
				const delContent = renderInlineTokens(host, token.tokens ?? [], resolvedStyleContext);
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
