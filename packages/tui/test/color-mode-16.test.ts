import assert from "node:assert";
import { describe, it } from "node:test";
import { backgroundAnsi, foregroundAnsi, indexedColor, oklchColor, rgbColor, styleText } from "../src/colors.ts";
import { getTerminalColorMode } from "../src/terminal-image/capabilities.ts";

const NO_TRUE_COLOR = { images: null, trueColor: false, hyperlinks: false } as const;

describe("16-color terminal tier", () => {
	it("is chosen for terminals that name themselves 16-color and not for 256-color or truecolor ones", () => {
		for (const TERM of ["linux", "ansi", "vt100", "xterm-color", "xterm-16color", "LINUX"]) {
			assert.strictEqual(getTerminalColorMode(NO_TRUE_COLOR, { TERM }), "16color", TERM);
		}
		for (const TERM of ["xterm-256color", "screen-256color", "xterm", "tmux-256color", undefined]) {
			assert.strictEqual(getTerminalColorMode(NO_TRUE_COLOR, { TERM }), "256color", String(TERM));
		}
		assert.strictEqual(getTerminalColorMode({ ...NO_TRUE_COLOR, trueColor: true }, { TERM: "linux" }), "truecolor");
		assert.strictEqual(getTerminalColorMode(NO_TRUE_COLOR, { TERM: "linux", NO_COLOR: "1" }), "none");
	});

	it("writes only the 8+8 ANSI color codes, nearest color first", () => {
		assert.strictEqual(foregroundAnsi(rgbColor(250, 20, 20), "16color"), "\x1b[91m");
		assert.strictEqual(foregroundAnsi(rgbColor(190, 10, 10), "16color"), "\x1b[31m");
		assert.strictEqual(foregroundAnsi(rgbColor(10, 10, 10), "16color"), "\x1b[30m");
		assert.strictEqual(backgroundAnsi(rgbColor(0, 0, 220), "16color"), "\x1b[44m");
		assert.strictEqual(backgroundAnsi(rgbColor(250, 250, 250), "16color"), "\x1b[107m");
	});

	it("keeps indexed ANSI colors and approximates the rest of the 256-color palette", () => {
		assert.strictEqual(foregroundAnsi(indexedColor(2), "16color"), "\x1b[32m");
		assert.strictEqual(foregroundAnsi(indexedColor(12), "16color"), "\x1b[94m");
		assert.strictEqual(foregroundAnsi(indexedColor(196), "16color"), "\x1b[91m");
	});

	it("converts OKLCH colors and leaves text attributes alone", () => {
		assert.match(foregroundAnsi(oklchColor(0.7, 0.2, 145), "16color"), /^\x1b\[(?:3[0-7]|9[0-7])m$/);
		const styled = styleText("x", { fg: rgbColor(250, 20, 20), bold: true }, "16color");
		assert.strictEqual(styled, "\x1b[91m\x1b[1mx\x1b[22m\x1b[39m");
	});
});
