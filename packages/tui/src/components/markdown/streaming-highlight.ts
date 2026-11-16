import { performance } from "node:perf_hooks";
import type { MarkdownTheme } from "./types.ts";

/** Code shorter than this is highlighted on every change: one pass costs less than a frame. */
const DEFER_MIN_CHARS = 8_000;
/** The least time between two full passes over one growing block. */
const MIN_INTERVAL_MS = 250;
/** A full pass may take at most one part in this many of the time a block streams. */
const COST_RATIO = 10;
/** Growing blocks remembered per message; a reply rarely streams more than one large block at a time. */
const MAX_BLOCKS = 4;

interface Highlighted {
	lang: string | undefined;
	code: string;
	lines: string[];
	costMs: number;
	at: number;
}

/**
 * A highlighter for a reply that is still streaming. Highlighting restarts from the first line on every change, so a
 * long block that grows by a few characters a frame would be coloured whole each frame. This one colours a large
 * growing block at most every `MIN_INTERVAL_MS` (longer when a pass is slow); between passes the lines already
 * coloured are kept and the new text takes the plain code-block colour. The finished reply is rendered with the
 * theme's own highlighter, so the final colouring is exact.
 */
export function streamingHighlighter(
	theme: MarkdownTheme,
	now: () => number = () => performance.now(),
): NonNullable<MarkdownTheme["highlightCode"]> {
	const full = theme.highlightCode;
	const blocks: Highlighted[] = [];
	return (code, lang) => {
		if (!full) return code.split("\n").map((line) => theme.codeBlock(line));
		if (code.length < DEFER_MIN_CHARS) return full(code, lang);
		const index = blocks.findIndex((block) => block.lang === lang && code.startsWith(block.code));
		const known = index < 0 ? undefined : blocks[index];
		if (known && code === known.code) return known.lines.slice();
		const time = now();
		if (known && time - known.at < Math.max(MIN_INTERVAL_MS, known.costMs * COST_RATIO)) {
			// The last coloured line may have been incomplete: it and everything after it are drawn plain.
			const lastLine = known.code.lastIndexOf("\n") + 1;
			const tail = code.slice(lastLine).split("\n");
			return [...known.lines.slice(0, -1), ...tail.map((line) => theme.codeBlock(line))];
		}
		const lines = full(code, lang);
		const block = { lang, code, lines, costMs: now() - time, at: now() };
		// A pass that does not give one line per source line cannot be extended line by line.
		if (lines.length !== code.split("\n").length) return lines;
		if (index >= 0) blocks[index] = block;
		else {
			blocks.push(block);
			if (blocks.length > MAX_BLOCKS) blocks.shift();
		}
		return lines.slice();
	};
}

/** `theme` with `streamingHighlighter` in place of its highlighter. */
export function streamingMarkdownTheme(theme: MarkdownTheme): MarkdownTheme {
	return theme.highlightCode ? { ...theme, highlightCode: streamingHighlighter(theme) } : theme;
}
