import assert from "node:assert";
import { describe, it } from "node:test";
import { rgbColor } from "../src/colors.ts";
import { shimmerText } from "../src/shimmer.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const base = rgbColor(100, 100, 100);
const peak = rgbColor(250, 250, 250);
const colorsOf = (text: string) => text.match(/\x1b\[38;2;[0-9;]*m/g) ?? [];

describe("shimmerText", () => {
	it("keeps the text and resets the foreground at the end", () => {
		const out = shimmerText("Working", { base, peak, mode: "truecolor", now: 1000 });
		assert.strictEqual(plain(out), "Working");
		assert.ok(out.endsWith("\x1b[39m"));
	});

	it("paints only the base color while the band is outside the text", () => {
		// At phase 0 the band's center sits `padding` cells before the text.
		const out = shimmerText("Working", { base, peak, mode: "truecolor", now: 0, padding: 10, halfWidth: 3 });
		assert.deepStrictEqual(colorsOf(out), ["\x1b[38;2;100;100;100m"]);
	});

	it("brightens the cells under the band's center", () => {
		// Period 2000 over 7 + 20 cells: the center reaches cell 3 at (13.5 / 27) of the period.
		const out = shimmerText("Working", { base, peak, mode: "truecolor", now: 1000, padding: 10, halfWidth: 3 });
		const colors = colorsOf(out);
		assert.ok(colors.length > 1);
		assert.ok(colors.some((color) => color === "\x1b[38;2;250;250;250m"));
	});

	it("moves with the clock", () => {
		const at = (now: number) => shimmerText("Working hard", { base, peak, mode: "truecolor", now });
		assert.notStrictEqual(at(800), at(1200));
		assert.strictEqual(at(800), at(2800));
	});

	it("returns empty text unchanged", () => {
		assert.strictEqual(shimmerText("", { base, peak, mode: "truecolor" }), "");
	});
	it("treats a ZWJ emoji as one two-cell cell, painted like any two-cell character", () => {
		const family = "👨‍👩‍👧";
		const at = (text: string, now: number) =>
			shimmerText(text, { base, peak, mode: "truecolor", now, padding: 10, halfWidth: 3 });
		for (const now of [200, 600, 1000, 1400]) {
			assert.strictEqual(at(`${family}ab`, now).replace(family, "🐙"), at("🐙ab", now), `now ${now}`);
		}
	});
});
