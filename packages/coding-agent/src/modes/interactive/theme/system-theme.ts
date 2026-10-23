/**
 * The `system` theme: pi's colors derived from the terminal's own theme.
 *
 * Every token belongs to a color family (its hue) and has contrast rules: it must reach a contrast level
 * on the background and on the panels it is drawn on. Hue and saturation come from the terminal's palette
 * color for the family's ANSI slot, or from the family's own hue when the terminal reports no palette.
 * Lightness comes from the rules alone. Colors are built in OKHSL, whose saturation is relative to the
 * sRGB gamut, and fade toward gray near black and white. A palette color never gains OKLCH chroma when it
 * moves to another lightness, so pastel palettes stay pastel.
 *
 * A contrast level is a target-lightness curve: the OKLab lightness a token needs, given the lightness of
 * the surface below it. The curves were fitted to the reference theme design from the "Pi themes: system
 * and light/dark" review. On dark backgrounds they aim for nearly fixed lightness; on light backgrounds the
 * required difference grows as the background darkens.
 *
 * Depending on what the terminal reports, the theme is generated in one of three tiers:
 * - background and palette: hues from the palette, lightness from the background;
 * - background only: the families' own hues, lightness from the background;
 * - nothing: ANSI palette indices and the default colors, which the terminal renders itself.
 */

import {
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	type OkhslChannels,
	okhslColor,
	oklabToOkhslLightness,
	oklchColor,
	type RgbColor,
	rgbColor,
} from "@octocodeai/octocode-tui";
import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";
import {
	type Curve,
	FAMILIES,
	type Family,
	type FamilyName,
	FOREGROUND_LEVEL,
	FOREGROUND_TOKENS,
	type Level,
	LEVELS,
	PANELS,
	READABLE_FLOOR,
	RULES,
	SOLVE_ORDER,
	type Surface,
	TEXT_MINIMUM_WCAG_CONTRAST,
	TOKEN_FAMILIES,
	TOKEN_SLOTS,
} from "./system-theme-recipe.ts";

export const SYSTEM_THEME_NAME = "system";

// ============================================================================
// Public API
// ============================================================================

export interface SystemThemeInput {
	foreground?: RgbColor;
	background?: RgbColor;
	/** ANSI colors 0-15. */
	palette?: RgbColor[];
	/** Saturation multiplier from 0 (grayscale) to 1. The first frame renders in grayscale until colors arrive. */
	saturation?: number;
	/** Appearance when the terminal did not report its background, e.g. from its light/dark report or COLORFGBG. */
	appearanceHint?: ThemeAppearance;
}

export interface SystemThemeColors {
	/** Hex colors, ANSI palette indices, or "" for the terminal default. */
	colors: Record<ThemeToken, string | number>;
	/** Foreground tokens rendered faint (SGR 2), for terminals that did not report colors. */
	dim: ThemeColor[];
	appearance: ThemeAppearance | undefined;
}

/** OKLab lightness of an sRGB color, 0-1. */
function oklabLightness(color: RgbColor): number {
	return colorToOklch(rgbColor(color.r, color.g, color.b)).l;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance({ r, g, b }: RgbColor): number {
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, 1-21. */
export function wcagContrast(first: RgbColor, second: RgbColor): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Whether a terminal is dark or light, from its reported colors: the direction of its own foreground
 * when text can be readable that way, otherwise dark when white text has more contrast on the
 * background than black text.
 */
export function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance {
	const white = { r: 255, g: 255, b: 255 };
	const black = { r: 0, g: 0, b: 0 };
	const whiteContrast = wcagContrast(white, background);
	const blackContrast = wcagContrast(black, background);
	if (foreground) {
		const foregroundL = oklabLightness(foreground);
		const backgroundL = oklabLightness(background);
		if (Math.abs(foregroundL - backgroundL) > 0.05) {
			const appearance = foregroundL > backgroundL ? "dark" : "light";
			const best = appearance === "dark" ? whiteContrast : blackContrast;
			if (best >= TEXT_MINIMUM_WCAG_CONTRAST) return appearance;
		}
	}
	return whiteContrast >= blackContrast ? "dark" : "light";
}

// ============================================================================
// Generation
// ============================================================================

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hexOf({ r, g, b }: RgbColor): string {
	return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** Saturation weight at a lightness: a Gaussian (center 0.5, sigma 0.25), 0 at black and white, 1 in the middle. */
function bellWeight(lightness: number): number {
	const gaussian = (x: number): number => Math.exp(-((x - 0.5) ** 2) / (2 * 0.25 ** 2));
	return (gaussian(lightness) - gaussian(0)) / (1 - gaussian(0));
}

/** A family's saturation curve relative to its maximum: 1 at mid lightness, `min / max` at black and white. */
function saturationCurve({ saturation: { min, max } }: Family, lightness: number): number {
	const floor = max > 0 ? min / max : 1;
	return floor + (1 - floor) * bellWeight(lightness);
}

/** The target lightness for a level on a surface, or undefined where the level cannot be reached. */
function levelTarget(level: Level, appearance: ThemeAppearance, surfaceL: number): number | undefined {
	const curve: Curve = LEVELS[level][appearance];
	if (surfaceL < curve.reachable[0] || surfaceL > curve.reachable[1]) return undefined;
	return curve.coefficients.reduce((sum, coefficient, power) => sum + coefficient * surfaceL ** power, 0);
}

/**
 * Generate the system theme's colors from the terminal's reported colors.
 */
export function generateSystemThemeColors(input: SystemThemeInput): SystemThemeColors {
	const saturation = clamp(input.saturation ?? 1, 0, 1);
	const { background, foreground } = input;
	if (!background) return indexedColors(saturation, input.appearanceHint);
	const palette = input.palette?.length === 16 ? input.palette.map(sourceOf) : undefined;

	const appearance = terminalAppearance(background, foreground);
	const lighter = appearance === "dark";
	const extreme = lighter ? 1 : 0;
	const backgroundL = oklabLightness(background);

	/**
	 * A token's color at an OKLab lightness. With a palette, the palette color's saturation applies at its
	 * own lightness and falls off toward black and white along the family's curve, never rising above it.
	 */
	const paint = (token: ThemeToken, oklabL: number): RgbColor => {
		const lightness = oklabToOkhslLightness(oklabL);
		const family: Family = FAMILIES[TOKEN_FAMILIES[token]];
		if (!palette) {
			const { min, max } = family.saturation;
			return okhslColor(family.hue, (min + (max - min) * bellWeight(lightness)) * saturation, lightness);
		}
		return anchored(palette[TOKEN_SLOTS[token] ?? family.slot], family, lightness, saturation);
	};

	/**
	 * The lightness a rule needs on a surface, relaxed by `t`: from 0 to 1, levels stronger than the readable
	 * floor move toward it; from 1 to 2, all levels move toward the surface itself.
	 */
	const target = (level: Level, surfaceL: number, t: number): number | undefined => {
		const reached = levelTarget(level, appearance, surfaceL);
		if (reached === undefined && t === 0) return undefined;
		const distance = (reached ?? extreme) - surfaceL;
		const floor = (levelTarget(READABLE_FLOOR[appearance], appearance, surfaceL) ?? extreme) - surfaceL;
		const compressed = Math.abs(distance) > Math.abs(floor) ? distance - (distance - floor) * Math.min(t, 1) : distance;
		return surfaceL + compressed * (1 - Math.max(0, t - 1));
	};

	/**
	 * Keep a panel light enough (or dark enough) that white (or black) text still reaches the body text
	 * minimum on it. This only matters for backgrounds near mid-gray, where it barely does on the background.
	 */
	const extremeText = lighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	const readable = (color: RgbColor) => wcagContrast(extremeText, color) >= TEXT_MINIMUM_WCAG_CONTRAST;
	const limitPanel = (token: ThemeToken, l: number): RgbColor => {
		const color = paint(token, l);
		if (readable(color)) return color;
		let [low, high] = [backgroundL, l];
		for (let index = 0; index < 20; index++) {
			const middle = (low + high) / 2;
			if (readable(paint(token, middle))) low = middle;
			else high = middle;
		}
		return paint(token, low);
	};

	const solve = (t: number): Map<Surface | ThemeToken, RgbColor> | undefined => {
		const colors = new Map<Surface | ThemeToken, RgbColor>([["background", background]]);
		for (const token of SOLVE_ORDER) {
			const targets: number[] = [];
			for (const rule of RULES) {
				if (rule.token !== token) continue;
				for (const surface of rule.on) {
					const value = target(rule.level, oklabLightness(colors.get(surface) ?? background), t);
					if (value === undefined || value < 0 || value > 1) return undefined;
					targets.push(value);
				}
			}
			const l = lighter ? Math.max(...targets) : Math.min(...targets);
			colors.set(token, PANELS.includes(token as ThemeBg) ? limitPanel(token, l) : paint(token, l));
		}
		return colors;
	};

	let relaxation = 0;
	let colors = solve(0);
	if (!colors) {
		// Mid-gray backgrounds cannot fit every level: relax as little as possible. Full relaxation always fits.
		let [low, high] = [0, 2];
		colors = solve(high);
		for (let index = 0; index < 20; index++) {
			const middle = (low + high) / 2;
			const attempt = solve(middle);
			if (attempt) [high, colors] = [middle, attempt];
			else low = middle;
		}
		relaxation = high;
	}
	const solved = colors ?? new Map<Surface | ThemeToken, RgbColor>();
	const surfacesOf = (token: ThemeToken) =>
		RULES.filter((rule) => rule.token === token).flatMap((rule) =>
			rule.on.map((surface) => solved.get(surface) ?? background),
		);

	const result = {} as Record<ThemeToken, string | number>;
	for (const token of Object.keys(TOKEN_FAMILIES) as ThemeToken[]) {
		const color = solved.get(token);
		result[token] = color ? hexOf(color) : "";
	}

	for (const token of FOREGROUND_TOKENS) {
		const surfaces = surfacesOf(token);
		// Body text uses the terminal's own foreground where it is clearly stronger than muted text; otherwise
		// the foreground's hue at just enough lightness.
		let text = solved.get(token);
		if (foreground) {
			const targets = surfaces.map((surface) => target(FOREGROUND_LEVEL, oklabLightness(surface), relaxation));
			if (targets.every((value) => value !== undefined && value >= 0 && value <= 1)) {
				const needed = lighter ? Math.max(...(targets as number[])) : Math.min(...(targets as number[]));
				const foregroundL = oklabLightness(foreground);
				if (lighter ? foregroundL >= needed : foregroundL <= needed) {
					result[token] = "";
					continue;
				}
				text = anchored(sourceOf(foreground), FAMILIES.neutral, oklabToOkhslLightness(needed), saturation);
			}
		}
		// Body text keeps at least 4.5:1 on the surfaces it is drawn on, even on relaxed mid-gray backgrounds.
		if (text) result[token] = hexOf(withTextContrast(text, surfaces, lighter));
	}
	return { colors: result, dim: [], appearance };
}

function okhslOf({ r, g, b }: RgbColor): OkhslChannels {
	return colorToOkhsl(rgbColor(r, g, b));
}

/** A terminal color's OKHSL channels and its OKLCH chroma. */
interface SourceColor extends OkhslChannels {
	chroma: number;
}

function sourceOf(color: RgbColor): SourceColor {
	return { ...okhslOf(color), chroma: colorToOklch(rgbColor(color.r, color.g, color.b)).c };
}

/**
 * A source color's hue at another OKHSL lightness. Its saturation applies at its own lightness and falls off
 * toward black and white along the family's saturation curve, never rising above it.
 *
 * OKHSL saturation is relative to the most chroma sRGB allows at a lightness, so the same saturation can mean
 * more chroma elsewhere: Catppuccin Frappe's pink #f4b8e4 (chroma 0.089) would become #eb76d1 (0.180) at the
 * lightness the accent needs. Chroma is therefore also capped at the source's, with the same falloff.
 */
function anchored(source: SourceColor, family: Family, lightness: number, saturation: number): RgbColor {
	const anchor = saturationCurve(family, source.l);
	const falloff = anchor > 0 ? Math.min(1, saturationCurve(family, lightness) / anchor) : 1;
	const color = okhslColor(source.h, source.s * falloff * saturation, lightness);
	const cap = source.chroma * falloff * saturation;
	const { l, c } = colorToOklch(color);
	return c <= cap ? color : colorToRgb(oklchColor(l, cap, source.h));
}

/** Move a text color toward white or black until it reaches the WCAG minimum on every surface. */
function withTextContrast(color: RgbColor, surfaces: RgbColor[], lighter: boolean): RgbColor {
	const meets = (candidate: RgbColor) =>
		surfaces.every((surface) => wcagContrast(candidate, surface) >= TEXT_MINIMUM_WCAG_CONTRAST);
	if (meets(color)) return color;
	const { h, s, l } = okhslOf(color);
	const at = (lightness: number) => okhslColor(h, s, lightness);
	const extreme = lighter ? 1 : 0;
	if (!meets(at(extreme))) return at(extreme);
	let [low, high] = [l, extreme];
	for (let index = 0; index < 20; index++) {
		const middle = (low + high) / 2;
		if (meets(at(middle))) high = middle;
		else low = middle;
	}
	return at(high);
}

/**
 * Colors for terminals that reported nothing: the terminal renders ANSI indices 0-15 and the default
 * colors with its own theme, so they fit any background. Neutral tokens below body text are faint (SGR 2)
 * instead of bright black, which some themes make nearly invisible. Panels have no background.
 */
function indexedColors(saturation: number, appearance: ThemeAppearance | undefined): SystemThemeColors {
	const colors = {} as Record<ThemeToken, string | number>;
	const dim: ThemeColor[] = [];
	for (const [token, familyName] of Object.entries(TOKEN_FAMILIES) as [ThemeToken, FamilyName][]) {
		if (PANELS.includes(token as ThemeBg)) {
			colors[token] = "";
			continue;
		}
		const neutral = familyName === "neutral";
		colors[token] = !neutral && saturation > 0 ? (TOKEN_SLOTS[token] ?? FAMILIES[familyName].slot) : "";
		if (neutral && !FOREGROUND_TOKENS.includes(token as ThemeColor)) dim.push(token as ThemeColor);
	}
	return { colors, dim, appearance };
}
