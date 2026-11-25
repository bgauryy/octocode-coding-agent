/**
 * Static theme gradients: the selected row, the neutral rule and transcript search matches. Each degrades to the
 * token's flat style where colors cannot blend (16 colors, no color, palette themes, terminal-default tokens), and
 * none animates: a painter is built once per theme and terminal colors, then paints by table lookup.
 */

import { createGradient, mixColors } from "@octocodeai/octocode-tui";
import type { Theme } from "./theme-class.ts";
import { theme as activeTheme } from "./theme-global.ts";

type Painter = ((text: string) => string) | undefined;
type GradientName = "selected" | "rule" | "searchMatch";

const painters = new WeakMap<Theme, { colors: Theme["colors"]; byName: Map<GradientName, Painter> }>();

function buildPainter(t: Theme, name: GradientName): Painter {
	const colors = t.colors;
	const mode = t.getColorMode();
	switch (name) {
		// The accent fades toward the text color along the row.
		case "selected":
			return createGradient({ from: colors.accent, to: mixColors(colors.accent, colors.text, 0.45), mode });
		// The rule is the border color in the middle and softens toward the background at both ends.
		case "rule":
			return createGradient({
				from: mixColors(colors.border, t.terminalDefaults.background, 0.55),
				to: colors.border,
				mode,
				shape: "center",
			});
		// The match band glows toward the accent in its middle.
		case "searchMatch":
			if (!t.paintsBackground("searchMatchBg")) return undefined;
			return createGradient({
				from: colors.searchMatchBg,
				to: mixColors(colors.searchMatchBg, colors.accent, 0.3),
				mode,
				layer: "background",
				shape: "center",
			});
	}
}

function painter(t: Theme, name: GradientName): Painter {
	const colors = t.colors;
	let entry = painters.get(t);
	// Terminal colors arriving (or the appearance changing) give the theme new resolved colors: rebuild.
	if (entry?.colors !== colors) {
		entry = { colors, byName: new Map() };
		painters.set(t, entry);
	}
	if (!entry.byName.has(name)) entry.byName.set(name, buildPainter(t, name));
	return entry.byName.get(name);
}

/** The selected row's text: an accent that fades along the row, else the flat accent. `text` should be plain. */
export function selectedText(text: string, t: Theme = activeTheme): string {
	return painter(t, "selected")?.(text) ?? t.fg("accent", text);
}

/** A neutral rule: the `border` color easing toward the background at both ends, else the flat `border`. */
export function borderRule(text: string, t: Theme = activeTheme): string {
	return painter(t, "rule")?.(text) ?? t.fg("border", text);
}

/** A transcript search match: `searchMatchText` on a band that glows toward the accent mid-match, else flat. */
export function searchMatchText(text: string, t: Theme = activeTheme): string {
	const glow = painter(t, "searchMatch");
	return glow ? t.fg("searchMatchText", glow(text)) : t.bg("searchMatchBg", t.fg("searchMatchText", text));
}
