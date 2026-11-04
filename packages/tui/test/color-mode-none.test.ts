import assert from "node:assert";
import { describe, it } from "node:test";
import { backgroundAnsi, foregroundAnsi, indexedColor, isColorDisabled, rgbColor, styleText } from "../src/colors.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { shimmerText } from "../src/shimmer.ts";
import { getTerminalColorMode } from "../src/terminal-image/capabilities.ts";
import { closeOpenStyles } from "../src/utils/ansi-tracker.ts";

const CAPABILITIES = { images: null, trueColor: true, hyperlinks: false } as const;
/** Any SGR that sets or resets a color: 30-37, 38, 39, 40-47, 48, 49, 90-97, 100-107. */
const COLOR_SGR = /\x1b\[(?:[34][0-9]|9[0-7]|10[0-7])[;m]/;

describe("no-color terminal mode", () => {
	it("is chosen by a non-empty NO_COLOR or TERM=dumb, and by nothing else", () => {
		assert.strictEqual(getTerminalColorMode(CAPABILITIES, { NO_COLOR: "1" }), "none");
		assert.strictEqual(getTerminalColorMode(CAPABILITIES, { TERM: "dumb" }), "none");
		assert.strictEqual(getTerminalColorMode(CAPABILITIES, { TERM: "DUMB" }), "none");
		// https://no-color.org: an empty NO_COLOR does not count.
		assert.strictEqual(getTerminalColorMode(CAPABILITIES, { NO_COLOR: "" }), "truecolor");
		assert.strictEqual(getTerminalColorMode(CAPABILITIES, { TERM: "xterm-256color" }), "truecolor");
		assert.strictEqual(getTerminalColorMode({ ...CAPABILITIES, trueColor: false }, {}), "256color");
		assert.strictEqual(isColorDisabled({}), false);
	});

	it("writes no color sequence for any color kind", () => {
		for (const color of [rgbColor(18, 52, 86), indexedColor(9)]) {
			assert.strictEqual(foregroundAnsi(color, "none"), "");
			assert.strictEqual(backgroundAnsi(color, "none"), "");
		}
	});

	it("keeps bold, dim, italic, underline and inverse, and drops fg and bg with their resets", () => {
		const styled = styleText(
			"Ready",
			{
				fg: rgbColor(1, 2, 3),
				bg: indexedColor(4),
				bold: true,
				dim: true,
				italic: true,
				underline: true,
				inverse: true,
			},
			"none",
		);
		assert.strictEqual(styled, "\x1b[1m\x1b[2m\x1b[3m\x1b[4m\x1b[7mReady\x1b[27m\x1b[24m\x1b[23m\x1b[22m");
		assert.doesNotMatch(styled, COLOR_SGR);
	});

	it("leaves shimmer text plain", () => {
		const out = shimmerText("Working", {
			base: rgbColor(0, 0, 0),
			peak: rgbColor(255, 255, 255),
			mode: "none",
			now: 1000,
		});
		assert.strictEqual(out, "Working");
	});
});

describe("scrollbar defaults", () => {
	it("use text attributes, not palette colors, when the host passes no styles", () => {
		const content = new Text(["a", "b", "c", "d", "e", "f", "g", "h"].join("\n"), 0, 0);
		const scrollView = new ScrollView(content, { scrollbar: "always" });
		scrollView.scrollBy(2);
		const lines = renderLayoutFrame(scrollView, 4, 4, () => {}).lines;
		assert.ok(
			lines.some((line) => line.includes("\u2502")),
			"track glyph is drawn",
		);
		assert.ok(
			lines.some((line) => line.includes("\u2503")),
			"thumb glyph is drawn",
		);
		for (const line of lines) assert.doesNotMatch(line, COLOR_SGR);
	});
});

describe("closeOpenStyles", () => {
	it("closes exactly the styles left open", () => {
		assert.strictEqual(closeOpenStyles("plain"), "");
		assert.strictEqual(closeOpenStyles("\x1b[1mbold\x1b[22m"), "");
		assert.strictEqual(closeOpenStyles("\x1b[48;5;4m\x1b[1mcut"), "\x1b[22;49m");
		assert.strictEqual(closeOpenStyles("\x1b[31m\x1b[4mcut\x1b[24m"), "\x1b[39m");
	});

	it("never emits a full reset", () => {
		assert.doesNotMatch(closeOpenStyles("\x1b[1m\x1b[3m\x1b[7m\x1b[9m\x1b[38;5;2m\x1b[48;5;3mx"), /\x1b\[0?m/);
	});
});
