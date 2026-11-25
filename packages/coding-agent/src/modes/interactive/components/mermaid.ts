import { Marked, type Token } from "@octocodeai/octocode-tui";
import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MarkdownTransformer } from "../../../core/features/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../../../theme/theme.ts";
import { trustedMarkdownTransformer } from "./markdown-transform.ts";

const markdownParser = new Marked();
/**
 * A fence line whose info string names Mermaid: a cheap superset of what `isMermaid` accepts, so text without one skips
 * lexing.
 */
const MERMAID_FENCE = /(?:`{3}|~{3})[^\n]*mermaid/i;
/**
 * Diagrams by source, least recently drawn first: a message drawn again (a new width, a theme change, a reload) reuses
 * its diagrams.
 */
const renderedDiagrams = new Map<string, MermaidArt | undefined>();
const MAX_RENDERED_DIAGRAMS = 32;

function renderDiagram(source: string): MermaidArt | undefined {
	if (renderedDiagrams.has(source)) {
		const cached = renderedDiagrams.get(source);
		renderedDiagrams.delete(source);
		renderedDiagrams.set(source, cached);
		return cached;
	}
	const art = render(source) ?? undefined;
	if (renderedDiagrams.size >= MAX_RENDERED_DIAGRAMS) {
		const oldest = renderedDiagrams.keys().next().value;
		if (oldest !== undefined) renderedDiagrams.delete(oldest);
	}
	renderedDiagrams.set(source, art);
	return art;
}

interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	// Encode each diagram row as inline code (` ... `) so Markdown preserves its spacing and
	// box-drawing characters. Use a non-breaking space for blank rows because an
	// empty code span has no visible height.
	const content = line || "\u00a0";
	// CommonMark code spans use matching backtick delimiters, so choose one
	// longer than any backtick run in the content (``hel`lo`` -> <code>hel`lo</code>).
	// If the content starts or ends with a backtick, separating it from the
	// delimiter with a space keeps that backtick as content; CommonMark removes
	// the padding when rendering (`` `edge` `` -> <code>`edge`</code>).
	// Mermaid labels can preserve backticks, for example:
	//   `┌──────────────┐    ┌──────────────┐`
	// ```│ plain ` tick ├───▶│ two `` ticks │```
	//   `└──────────────┘    └──────────────┘`
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/**
 * Create a transformer that replaces top-level Mermaid code blocks with Unicode terminal diagrams. It is trusted: it runs
 * after the final sanitize, since its output is the sanitized Markdown it is given plus diagrams drawn from that text and
 * the theme's colours, which sanitizing would strip.
 */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	return trustedMarkdownTransformer((markdown, context) => {
		const mode = options.getMode();
		if (
			mode === "off" ||
			context.messageType === "assistant-thinking" ||
			// A streaming reply shows as plain text, so diagrams wait for the final reply; a saved `streaming` mode acts
			// as `final`.
			context.isStreaming ||
			!MERMAID_FENCE.test(markdown)
		) {
			return markdown;
		}

		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = renderDiagram(token.text);
				if (!art || art.width > context.availableWidth) return token.raw;
				if (art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				// Markdown hard breaks keep every diagram row on its own line.
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	});
}
