import { colorToOkhsl, colorToRgb } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { loadTheme } from "../src/theme/theme-loader.ts";
import type { ThemeToken } from "../src/theme/theme-tokens.ts";

const THEMES = ["light", "dark", "octocode-light", "octocode-dark"] as const;

/** Backgrounds a theme's text can land on: the terminal (guessed black or a common dark grey, or white) and every band. */
const TERMINAL_BG = {
	light: ["#ffffff"],
	dark: ["#000000", "#1e1e1e"],
} as const;
const BANDS: ThemeToken[] = [
	"userMessageBg",
	"selectedBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"customMessageBg",
];

/** Text: read as words (4.5:1, WCAG AA). */
const TEXT: ThemeToken[] = [
	"accent",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"toolReason",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdQuote",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
];

/** Glyphs and rules that carry meaning: seen as shapes (3:1, WCAG non-text). */
const GLYPH: ThemeToken[] = [
	"borderAccent",
	"scrollbarThumb",
	"mdCodeBlockBorder",
	"mdQuoteBorder",
	"mdHr",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
];

/** Decorative hairlines: may be quiet, never invisible. */
const HAIRLINE: ThemeToken[] = ["border", "borderMuted", "scrollbarTrack"];

function luminance(hex: { r: number; g: number; b: number }): number {
	const [r, g, b] = [hex.r, hex.g, hex.b].map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function hexRgb(hex: string) {
	return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

/** The lowest contrast of `token` against every background it can be drawn on, with the background that sets it. */
function worst(name: (typeof THEMES)[number], token: ThemeToken, withBands: boolean): { ratio: number; on: string } {
	const theme = loadTheme(name, "truecolor");
	const fg = colorToRgb(theme.colors[token]);
	const backgrounds: [string, { r: number; g: number; b: number }][] = TERMINAL_BG[theme.appearance].map((hex) => [
		`terminal ${hex}`,
		hexRgb(hex),
	]);
	if (withBands) for (const band of BANDS) backgrounds.push([band, colorToRgb(theme.colors[band])]);
	let result = { ratio: Infinity, on: "" };
	for (const [on, bg] of backgrounds) {
		const value = ratio(fg, bg);
		if (value < result.ratio) result = { ratio: value, on };
	}
	return result;
}

function failures(name: (typeof THEMES)[number], tokens: ThemeToken[], floor: number, withBands: boolean): string[] {
	return tokens.flatMap((token) => {
		const { ratio: value, on } = worst(name, token, withBands);
		return value >= floor ? [] : [`${token} ${value.toFixed(2)}:1 on ${on} (needs ${floor})`];
	});
}

describe.each(THEMES)("theme contrast: %s", (name) => {
	it("keeps every text token at 4.5:1 on the terminal and every band", () => {
		expect(failures(name, TEXT, 4.5, true)).toEqual([]);
	});

	it("keeps glyph and border tokens at 3:1 on the terminal and every band", () => {
		expect(failures(name, GLYPH, 3, true)).toEqual([]);
	});

	it("keeps decorative hairlines visible on the terminal", () => {
		expect(failures(name, HAIRLINE, 1.5, false)).toEqual([]);
	});

	it("keeps the bash frame neutral: no state hue (success, error, warning)", () => {
		const theme = loadTheme(name, "truecolor");
		const bash = colorToOkhsl(theme.colors.bashMode);
		for (const state of ["success", "error", "warning"] as const) {
			const other = colorToOkhsl(theme.colors[state]);
			const hueGap = Math.min(Math.abs(bash.h - other.h), 360 - Math.abs(bash.h - other.h));
			// Neutral means nearly grey, or a clearly different hue.
			expect(bash.s < 0.15 || hueGap > 40, `bashMode vs ${state}`).toBe(true);
		}
	});

	it("keeps inline code off the accent colour", () => {
		const theme = loadTheme(name, "truecolor");
		expect(colorToRgb(theme.colors.mdCode)).not.toEqual(colorToRgb(theme.colors.accent));
	});
});
