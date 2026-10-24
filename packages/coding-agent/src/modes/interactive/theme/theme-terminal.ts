import type { TerminalColors } from "@octocodeai/octocode-tui";
import { terminalAppearance } from "./system-theme.ts";

/** Whether a terminal, or the background a theme is designed for, is dark or light. */
export type ThemeAppearance = "dark" | "light";

// ============================================================================
// Appearance & Terminal Default Colors
// ============================================================================

// The terminal's reported colors. Replaced (never mutated) on update, so themes can cache resolved colors
// by identity.
let terminalColors: TerminalColors = {};
// While the terminal color query is in flight, the system theme renders in grayscale.
let terminalColorsPending = false;
// The terminal's last light/dark report (mode 2031). Only used while it has not reported a background.
let terminalColorScheme: ThemeAppearance | undefined;

/**
 * Record the terminal's reported colors. Themes use the default colors for tokens set to "" (terminal
 * default); the system theme is generated from all of them. Ends the pending state.
 */
export function setTerminalColors(colors: TerminalColors): void {
	terminalColors = { ...colors };
	terminalColorsPending = false;
}

/** Record the terminal's light/dark report, the fallback for terminals that do not report their background. */
export function setTerminalColorScheme(scheme: ThemeAppearance | undefined): void {
	terminalColorScheme = scheme;
}

/** Render the system theme in grayscale until `setTerminalColors()` reports the terminal's colors. */
export function markTerminalColorsPending(): void {
	terminalColorsPending = true;
}

/** The terminal's reported colors; the same object until `setTerminalColors()` replaces it. */
export function getTerminalColors(): TerminalColors {
	return terminalColors;
}

/** Whether the terminal color query is still in flight. */
export function areTerminalColorsPending(): boolean {
	return terminalColorsPending;
}

export function parseAutoThemeSetting(
	themeSetting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

export function resolveThemeSetting(
	themeSetting: string | undefined,
	terminalTheme: ThemeAppearance,
): string | undefined {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

/**
 * Dark or light from the `COLORFGBG` environment variable some terminals set, or undefined without a
 * usable background index. The value is `fg;bg` or `fg;xpm;bg` (rxvt), where a field is an ANSI color
 * index or `default` when the color is not in the palette. The index refers to the terminal's own palette,
 * whose colors are unknown here, so it is classified by index like Vim does: 0-6 and 8 (bright black, e.g.
 * Solarized Dark's background) are dark, 7 and 9-15 are light.
 */
export function detectColorFgBgTheme(env: NodeJS.ProcessEnv = process.env): ThemeAppearance | undefined {
	const bg = env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!bg || !/^\d{1,2}$/.test(bg)) return undefined;
	const index = Number(bg);
	if (index > 15) return undefined;
	return index <= 6 || index === 8 ? "dark" : "light";
}

/**
 * Whether the terminal is dark or light. The background it renders decides, classified the same way the
 * system theme does. Without a reported background: the terminal's light/dark report, then COLORFGBG,
 * then dark.
 */
export function detectTerminalTheme(
	colors: TerminalColors = {},
	reportedScheme?: ThemeAppearance,
	env: NodeJS.ProcessEnv = process.env,
): ThemeAppearance {
	const { background, foreground } = colors;
	if (background) return terminalAppearance(background, foreground);
	return reportedScheme ?? detectColorFgBgTheme(env) ?? "dark";
}

/** Whether the terminal is dark or light, from everything it reported so far. See `detectTerminalTheme()`. */
export function getTerminalTheme(): ThemeAppearance {
	return detectTerminalTheme(terminalColors, terminalColorScheme);
}
