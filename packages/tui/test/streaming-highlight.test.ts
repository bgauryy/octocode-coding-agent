import assert from "node:assert";
import { it, mock } from "node:test";
import { streamingHighlighter, streamingMarkdownTheme } from "../src/components/markdown/streaming-highlight.ts";
import type { MarkdownTheme } from "../src/components/markdown/types.ts";

function fixture() {
	const full = mock.fn((code: string) => code.split("\n").map((line) => `<${line}>`));
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
	assert.strictEqual(f.full.mock.callCount(), 2);
});

it("keeps the coloured lines of a large growing block and draws the new text plain until the next pass", () => {
	const f = fixture();
	const first = f.highlight(big, "ts");
	assert.strictEqual(first.at(-1), "<const last>");
	f.advance(40);
	const grown = f.highlight(`${big} = 2;\nnext line`, "ts");
	assert.strictEqual(f.full.mock.callCount(), 1);
	assert.strictEqual(grown.length, first.length + 1);
	assert.deepStrictEqual(grown.slice(0, -2), first.slice(0, -1));
	// The line that was incomplete at the last pass is redrawn whole, plain.
	assert.deepStrictEqual(grown.slice(-2), ["[const last = 2;]", "[next line]"]);

	f.advance(300);
	const later = f.highlight(`${big} = 2;\nnext line`, "ts");
	assert.strictEqual(f.full.mock.callCount(), 2);
	assert.deepStrictEqual(later.slice(-2), ["<const last = 2;>", "<next line>"]);
});

it("returns unchanged code from the last pass and highlights rewritten code at once", () => {
	const f = fixture();
	const first = f.highlight(big, "ts");
	assert.deepStrictEqual(f.highlight(big, "ts"), first);
	assert.strictEqual(f.full.mock.callCount(), 1);
	f.highlight(`changed ${big}`, "ts");
	assert.strictEqual(f.full.mock.callCount(), 2);
});

it("leaves a theme without a highlighter as it is", () => {
	const theme = { codeBlock: (line: string) => line } as unknown as MarkdownTheme;
	assert.strictEqual(streamingMarkdownTheme(theme), theme);
});
