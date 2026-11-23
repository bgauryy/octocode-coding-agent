import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { clearWidthCache, graphemeSegments, graphemeWidth, visibleWidth } from "../src/utils/width.ts";

/** What measuring by segmenting everything gives: the reference the fast paths must match. */
const reference = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const segmentsOf = (text: string): string[] => Array.from(reference.segment(text), ({ segment }) => segment);
const segmentedWidth = (text: string): number =>
	segmentsOf(text).reduce((sum, segment) => sum + graphemeWidth(segment), 0);

/** Every code unit below the CJK block, each in the company that could join it to a neighbour or split it apart. */
function* samples(): Generator<string> {
	for (let code = 0xa0; code < 0x3000; code++) {
		if (code >= 0xd800) break;
		const c = String.fromCharCode(code);
		yield* [c, `a${c}b`, `${c}${c}`, `${c}\u0301`, `${c}\uFE0F`, `${c}\u200D${c}`, `\u3042${c}`, `${c} \u00B7`];
	}
}

describe("standalone characters below U+3000", () => {
	it("measure and split as segmenting everything does", () => {
		clearWidthCache();
		for (const text of samples()) {
			assert.strictEqual(visibleWidth(text), segmentedWidth(text), JSON.stringify(text));
			assert.deepStrictEqual([...graphemeSegments(text)], segmentsOf(text), JSON.stringify(text));
		}
	});

	it("keep common symbols at their widths", () => {
		assert.strictEqual(visibleWidth(" \u00B7 "), 3);
		assert.strictEqual(visibleWidth("\u2500\u2502\u250C\u2510\u2514\u2518"), 6);
		assert.strictEqual(visibleWidth("\u280B \u2026 \u2022 \u2713 \u2717 \u2192 \u25B6"), 13);
		assert.strictEqual(visibleWidth("\u231A"), 2);
		assert.strictEqual(visibleWidth("\u2600\uFE0F"), 2);
		assert.strictEqual(visibleWidth("e\u0301"), 1);
	});
});

describe("segmenters", () => {
	it("are made on first use, and standalone text needs none", () => {
		const width = fileURLToPath(new URL("../src/utils/width.ts", import.meta.url));
		const script = `
			let made = 0;
			const Real = Intl.Segmenter;
			Intl.Segmenter = class extends Real { constructor(...args) { super(...args); made++; } };
			const { visibleWidth } = await import(${JSON.stringify(width)});
			const counts = [made];
			visibleWidth(" \\u00B7 \u2500 \u2192 \u2713 \u00E9");
			counts.push(made);
			visibleWidth("e\\u0301");
			counts.push(made);
			console.log(counts.join(","));
		`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		assert.strictEqual(output.trim(), "0,0,1");
	});
});
