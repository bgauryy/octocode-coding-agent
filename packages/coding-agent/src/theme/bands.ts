import { backgroundAnsi, mixColors } from "@octocodeai/octocode-tui";
import { theme } from "./theme.ts";
import type { ThemeBg } from "./theme-types.ts";

/** Which tool state a band marks; each blends its own state color into the terminal background. */
export type ToolBandState = "pending" | "success" | "error";

const BAND_TOKEN: Record<ToolBandState, ThemeBg> = {
	pending: "toolPendingBg",
	success: "toolSuccessBg",
	error: "toolErrorBg",
};
const BAND_SOURCE = { pending: "muted", success: "success", error: "error" } as const;
/** How much of the state color blends into the background: quiet enough to keep every text color's contrast. */
const BAND_ALPHA = { dark: 0.06, light: 0.08 } as const;

let toolBands = false;

/** Turn the optional tool bands on or off (the `terminal.toolBands` setting). */
export function setToolBands(enabled: boolean): void {
	toolBands = enabled;
}

/**
 * `text` on a tool band. A theme that declares its own band color keeps it. Otherwise, with bands on, the band is the
 * state color alpha-blended on the terminal's real background (declared or measured, else the theme's guess); with bands
 * off or without color, the text is left on the terminal background.
 */
export function toolBand(state: ToolBandState, text: string): string {
	const token = BAND_TOKEN[state];
	if (theme.paintsBackground(token)) return theme.bg(token, text);
	const mode = theme.getColorMode();
	if (!toolBands || mode === "none") return theme.bg(token, text);
	const base = theme.terminalDefaults.background;
	const source = theme.colors[BAND_SOURCE[state]];
	const band = mixColors(base, source, BAND_ALPHA[theme.appearance === "light" ? "light" : "dark"], "srgb");
	return `${backgroundAnsi(band, mode)}${text}\x1b[49m`;
}

/** The message panels that can take a blended fill: the user's own messages, and notices and custom entries. */
export type SurfaceFillKind = "user" | "custom";

const SURFACE_TOKEN: Record<SurfaceFillKind, ThemeBg> = { user: "userMessageBg", custom: "customMessageBg" };
/** What a fill blends in: the user panel lightens or darkens toward the text color, a notice panel tints toward the accent. */
const SURFACE_SOURCE = { user: "text", custom: "accent" } as const;
const SURFACE_ALPHA = {
	user: { dark: 0.06, light: 0.05 },
	custom: { dark: 0.08, light: 0.08 },
} as const;

let surfaceFills = false;

/** Turn the optional blended message panels on or off (the `terminal.surfaceFills` setting). */
export function setSurfaceFills(enabled: boolean): void {
	surfaceFills = enabled;
}

/**
 * `text` on a message panel. Off (the default), the theme's own panel color paints. On, the panel is a quiet tint blended
 * on the terminal's real background (declared or measured, else the theme's guess), so it fits whatever the terminal
 * uses; without color, the theme paints as before.
 */
export function surfaceFill(kind: SurfaceFillKind, text: string): string {
	const mode = theme.getColorMode();
	if (!surfaceFills || mode === "none") return theme.bg(SURFACE_TOKEN[kind], text);
	const base = theme.terminalDefaults.background;
	const source = theme.colors[SURFACE_SOURCE[kind]];
	const fill = mixColors(base, source, SURFACE_ALPHA[kind][theme.appearance === "light" ? "light" : "dark"], "srgb");
	return `${backgroundAnsi(fill, mode)}${text}\x1b[49m`;
}
