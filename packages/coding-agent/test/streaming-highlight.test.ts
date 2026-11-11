import type { MarkdownTheme } from "@octocodeai/octocode-tui";
import { expect, it, vi } from "vitest";
import {
	streamingHighlighter,
	streamingMarkdownTheme,
} from "../src/modes/interactive/components/streaming-highlight.ts";

function fixture() {
	const full = vi.fn((code: string) => code.split("\n").map((line) => `<${line}>`));
	const theme = { codeBlock: (line: string) => `[${line}]`, highlightCode: full } as unknown as MarkdownTheme;
	let time = 0;
	const highlight = streamingHighlighter(theme, () => time);
	return { full, theme, highlight, advance: (ms: number) => (time += ms) };
}
const big = `${"const value = 1;\n".repeat(600)}const last`;

it("highlights a short block on every change", () => {
	const f = fixture();
	f.highlight("a\nb", "ts");
	f.highlight("a\nbc", "ts");
	expect(f.full).toHaveBeenCalledTimes(2);
});

it("keeps the coloured lines of a large growing block and draws the new text plain until the next pass", () => {
	const f = fixture();
	const first = f.highlight(big, "ts");
	expect(first.at(-1)).toBe("<const last>");
	f.advance(40);
	const grown = f.highlight(`${big} = 2;\nnext line`, "ts");
	expect(f.full).toHaveBeenCalledTimes(1);
	expect(grown).toHaveLength(first.length + 1);
	expect(grown.slice(0, -2)).toEqual(first.slice(0, -1));
	// The line that was incomplete at the last pass is redrawn whole, plain.
	expect(grown.slice(-2)).toEqual(["[const last = 2;]", "[next line]"]);

	f.advance(300);
	const later = f.highlight(`${big} = 2;\nnext line`, "ts");
	expect(f.full).toHaveBeenCalledTimes(2);
	expect(later.slice(-2)).toEqual(["<const last = 2;>", "<next line>"]);
});

it("returns unchanged code from the last pass and highlights rewritten code at once", () => {
	const f = fixture();
	const first = f.highlight(big, "ts");
	expect(f.highlight(big, "ts")).toEqual(first);
	expect(f.full).toHaveBeenCalledTimes(1);
	f.highlight(`changed ${big}`, "ts");
	expect(f.full).toHaveBeenCalledTimes(2);
});

it("leaves a theme without a highlighter as it is", () => {
	const theme = { codeBlock: (line: string) => line } as unknown as MarkdownTheme;
	expect(streamingMarkdownTheme(theme)).toBe(theme);
});
