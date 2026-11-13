import { colorToHex } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { splitThemeColors, Theme } from "../src/theme/theme-class.ts";
import { setTerminalColorScheme, setTerminalColors } from "../src/theme/theme-terminal.ts";
import { THEME_TOKENS, type ResolvedThemeColorValues } from "../src/theme/theme-tokens.ts";

function paletteTheme(appearance?: "dark" | "light"): Theme {
	const values = Object.fromEntries(
		Object.entries(THEME_TOKENS).map(([token, descriptor]) => [
			token,
			descriptor.slot === "background" || token === "text" ? "" : 7,
		]),
	) as ResolvedThemeColorValues<string | number>;
	const { fgColors, bgColors } = splitThemeColors(values);
	return new Theme(fgColors, bgColors, "truecolor", { appearance });
}

afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
});

describe("concrete theme defaults", () => {
	it("refreshes inferred defaults when only the terminal appearance changes", () => {
		setTerminalColors({});
		setTerminalColorScheme("dark");
		const theme = paletteTheme();
		const dark = theme.colors;
		expect(theme.appearance).toBe("dark");
		expect(colorToHex(dark.text)).toBe("#e5e5e7");

		setTerminalColorScheme("light");
		expect(theme.appearance).toBe("light");
		expect(colorToHex(theme.colors.text)).toBe("#000000");
		expect(colorToHex(theme.colors.selectedBg)).toBe("#ffffff");
		expect(theme.colors).not.toBe(dark);
		expect(theme.colors).toBe(theme.colors);
	});

	it("keeps declared theme defaults and the cached colors when the terminal scheme changes", () => {
		setTerminalColors({});
		setTerminalColorScheme("dark");
		const theme = paletteTheme("dark");
		const colors = theme.colors;
		setTerminalColorScheme("light");
		expect(theme.appearance).toBe("dark");
		expect(theme.colors).toBe(colors);
	});
});
