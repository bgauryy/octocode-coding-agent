import assert from "node:assert";
import { describe, it } from "node:test";
import { extractAnsiCode } from "../src/utils/ansi-codes.ts";
import { getActiveOsc8Close } from "../src/utils/ansi-tracker.ts";
import { truncateToWidth } from "../src/utils/truncate.ts";
import { graphemeSegmenter, graphemeWidth, visibleWidth } from "../src/utils/width.ts";

/** The segment-every-grapheme truncation the single pass replaced, kept as the reference for its output. */
function reference(text: string, maxWidth: number, ellipsis = "…"): string {
	const ellipsisWidth = visibleWidth(ellipsis);
	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pending = "";
	let seen = 0;
	let kept = 0;
	let contiguous = true;
	const take = (segment: string, width: number): boolean => {
		if (contiguous && kept + width <= targetWidth) {
			result += pending + segment;
			pending = "";
			kept += width;
		} else {
			contiguous = false;
			pending = "";
		}
		seen += width;
		return seen <= maxWidth;
	};
	let i = 0;
	let overflowed = false;
	while (i < text.length && !overflowed) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			pending += ansi.code;
			i += ansi.length;
			continue;
		}
		if (text[i] === "\t") {
			overflowed = !take("\t", 3);
			i++;
			continue;
		}
		let end = i;
		while (end < text.length && text[end] !== "\t" && !extractAnsiCode(text, end)) end++;
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			if (!take(segment, graphemeWidth(segment))) {
				overflowed = true;
				break;
			}
		}
		i = end;
	}
	if (!overflowed) return text;
	return `${result}${getActiveOsc8Close(result)}\x1b[0m${ellipsis}\x1b[0m`;
}

function random(seed: number): (limit: number) => number {
	let state = seed;
	return (limit) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return Math.floor((state / 2147483648) * limit);
	};
}

describe("truncateToWidth single pass", () => {
	it("cuts every mix of styles, tabs, wide, combining and emoji text where segmenting each grapheme did", () => {
		const pieces = [
			"plain ascii words ",
			"\x1b[31m",
			"\x1b[39m",
			"\x1b]8;;https://example.com\x07",
			"\x1b]8;;\x07",
			"\t",
			"日本語",
			"é",
			"👨‍👩‍👧",
			"⎿  ",
			"│",
			"héllo wörld ",
			"x".repeat(40),
			"\x1b",
		];
		for (let seed = 1; seed <= 600; seed++) {
			const next = random(seed);
			let text = "";
			for (let part = 0; part < 1 + next(14); part++) text += pieces[next(pieces.length)];
			for (const width of [1, 2, 5, 13, 40, 80]) {
				if (visibleWidth("…") >= width) continue;
				assert.strictEqual(truncateToWidth(text, width), reference(text, width), `seed ${seed} width ${width}`);
			}
		}
	});

	it("stops at the width instead of reading a long styled row to its end", () => {
		const row = `\x1b[38;5;66m  ⎿  \x1b[39m\x1b[38;5;145m${"const value = compute(input); ".repeat(4000)}\x1b[39m`;
		const start = performance.now();
		for (let index = 0; index < 200; index++) truncateToWidth(row, 196);
		const perRow = (performance.now() - start) / 200;
		assert.strictEqual(truncateToWidth(row, 196), reference(row, 196));
		assert.ok(perRow < 0.1, `${(perRow * 1000).toFixed(1)} µs per 120 KB row`);
	});
});
