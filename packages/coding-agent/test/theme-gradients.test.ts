import { resetCapabilitiesCache, setCapabilities } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { borderRule, searchMatchText, selectedText } from "../src/theme/gradients.ts";
import { loadTheme } from "../src/theme/theme-loader.ts";
import { initTheme } from "../src/theme/theme.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const codes = (text: string, layer: 38 | 48): string[] =>
	text.match(new RegExp(`\\x1b\\[${layer};[0-9;]*m`, "g")) ?? [];

describe("theme gradients", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("fades the selected row from the accent along the text in truecolor", () => {
		const t = loadTheme("dark", "truecolor");
		const row = "Selected picker row";
		const out = selectedText(row, t);
		expect(plain(out)).toBe(row);
		const colors = codes(out, 38);
		expect(colors[0]).toBe(t.getFgAnsi("accent"));
		expect(new Set(colors).size).toBeGreaterThan(3);
		expect(colors.at(-1)).not.toBe(t.getFgAnsi("accent"));
	});

	it("quantizes the fade to 256-color codes", () => {
		const out = selectedText("Selected picker row", loadTheme("dark", "256color"));
		expect(codes(out, 38).length).toBeGreaterThan(0);
		expect(codes(out, 38).every((code) => code.startsWith("\x1b[38;5;"))).toBe(true);
	});

	it("keeps the flat styles in 16 colors, without color and for palette themes", () => {
		for (const t of [
			loadTheme("dark", "16color"),
			loadTheme("dark", "none"),
			loadTheme("octocode-ansi", "truecolor"),
		]) {
			expect(selectedText("row", t)).toBe(t.fg("accent", "row"));
			expect(borderRule("────", t)).toBe(t.fg("border", "────"));
			expect(searchMatchText("hit", t)).toBe(t.bg("searchMatchBg", t.fg("searchMatchText", "hit")));
		}
	});

	it("draws the rule full strength in the middle and softer at both ends", () => {
		const t = loadTheme("dark", "truecolor");
		const out = borderRule("─".repeat(40), t);
		expect(plain(out)).toBe("─".repeat(40));
		const colors = codes(out, 38);
		expect(colors).toContain(t.getFgAnsi("border"));
		expect(colors[0]).not.toBe(t.getFgAnsi("border"));
		expect(colors[0]).toBe(colors.at(-1));
	});

	it("glows the search match background in its middle and keeps the match text color", () => {
		const t = loadTheme("dark", "truecolor");
		const out = searchMatchText("needle", t);
		expect(plain(out)).toBe("needle");
		expect(out.startsWith(t.getFgAnsi("searchMatchText"))).toBe(true);
		const backgrounds = codes(out, 48);
		expect(backgrounds[0]).toBe(t.getBgAnsi("searchMatchBg"));
		expect(new Set(backgrounds).size).toBeGreaterThan(1);
		expect(out.endsWith("\x1b[49m\x1b[39m")).toBe(true);
	});

	it("returns the same painting on every render: static, nothing tied to time", () => {
		const t = loadTheme("dark", "truecolor");
		expect(selectedText("row text", t)).toBe(selectedText("row text", t));
	});
});
