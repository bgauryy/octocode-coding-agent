import assert from "node:assert";
import { describe, it } from "node:test";
import { indexedColor, rgbColor } from "../src/colors.ts";
import { canBlendColors, createGradient } from "../src/gradient.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const from = rgbColor(0, 0, 0);
const to = rgbColor(255, 255, 255);
const sgr = (text: string, layer: 38 | 48): string[] => text.match(new RegExp(`\\x1b\\[${layer};[0-9;]*m`, "g")) ?? [];

describe("createGradient", () => {
	it("ramps from the first color to the second across the text in truecolor", () => {
		const paint = createGradient({ from, to, mode: "truecolor" });
		assert.ok(paint);
		const out = paint("abcdefghi");
		assert.strictEqual(plain(out), "abcdefghi");
		const colors = sgr(out, 38);
		assert.strictEqual(colors[0], "\x1b[38;2;0;0;0m");
		assert.strictEqual(colors.at(-1), "\x1b[38;2;255;255;255m");
		assert.strictEqual(colors.length, 9);
		assert.ok(out.endsWith("\x1b[39m"));
	});

	it("puts the second color in the middle with the center shape, on the background layer", () => {
		const paint = createGradient({ from, to, mode: "truecolor", shape: "center", layer: "background" });
		assert.ok(paint);
		const out = paint("abcde");
		const colors = sgr(out, 48);
		assert.strictEqual(colors[0], "\x1b[48;2;0;0;0m");
		assert.ok(colors.includes("\x1b[48;2;255;255;255m"));
		assert.strictEqual(colors.at(-1), "\x1b[48;2;0;0;0m");
		assert.ok(out.endsWith("\x1b[49m"));
		assert.deepStrictEqual(sgr(out, 38), []);
	});

	it("quantizes to 256-color codes and merges equal neighbours", () => {
		const paint = createGradient({ from: rgbColor(90, 0, 140), to: rgbColor(100, 0, 150), mode: "256color" });
		assert.ok(paint);
		const out = paint("abcdefgh");
		assert.strictEqual(plain(out), "abcdefgh");
		assert.ok(sgr(out, 38).every((code) => /^\x1b\[38;5;\d+m$/.test(code)));
		// Two near colors land on one cube entry: one sequence, not one per cell.
		assert.strictEqual(sgr(out, 38).length, 1);
	});

	it("refuses 16 colors, no color and palette colors, so callers keep their flat style", () => {
		assert.strictEqual(createGradient({ from, to, mode: "16color" }), undefined);
		assert.strictEqual(createGradient({ from, to, mode: "none" }), undefined);
		assert.strictEqual(createGradient({ from: indexedColor(13), to, mode: "truecolor" }), undefined);
		assert.strictEqual(canBlendColors(from, to, "256color"), true);
	});

	it("paints styled text flat in the first color and leaves empty text alone", () => {
		const paint = createGradient({ from, to, mode: "truecolor" });
		assert.ok(paint);
		assert.strictEqual(paint("\x1b[1mhi\x1b[22m"), "\x1b[38;2;0;0;0m\x1b[1mhi\x1b[22m\x1b[39m");
		assert.strictEqual(paint(""), "");
	});

	it("counts wide characters by their cell width", () => {
		const paint = createGradient({ from, to, mode: "truecolor" });
		assert.ok(paint);
		const out = paint("日本");
		assert.strictEqual(plain(out), "日本");
		// Cells 0 and 2 of 4: the second character sits two thirds along, not at the end.
		assert.notStrictEqual(sgr(out, 38).at(-1), "\x1b[38;2;255;255;255m");
	});
});
