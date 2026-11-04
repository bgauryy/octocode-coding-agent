import {
	animationClock,
	breathe,
	type Color,
	GLYPH,
	MOTION,
	mixColors,
	rgbColor,
	SPINNER,
	settle,
	type UiState,
} from "@octocodeai/octocode-tui";
import type { ThemeColor } from "./theme-tokens.ts";

export type { UiState };

/** The colour role of each state: the only place a state picks its colour. */
export const STATE_COLOR = {
	pending: "dim",
	running: "accent",
	waiting: "warning",
	done: "success",
	failed: "error",
	stopped: "muted",
} as const satisfies Readonly<Record<UiState, ThemeColor>>;

/** A footer status (text and tone as data) painted in the live theme; a status without a tone as written. */
export function paintStatus(
	status: { text: string; tone?: ThemeColor },
	paint: { fg(color: ThemeColor, text: string): string },
): string {
	return status.tone ? paint.fg(status.tone, status.text) : status.text;
}

/** What a mark needs from a theme: token colours, and concrete colours for glows when the theme has them. */
export interface MarkTheme {
	fg(color: ThemeColor, text: string): string;
	style?(text: string, options: { fg?: Color }): string;
	readonly colors?: Readonly<Partial<Record<string, Color>>>;
	readonly appearance?: "dark" | "light";
}

export interface MarkOptions {
	/** Frame time (default now). */
	now?: number;
	/** When the state was entered: a `done` mark glows briefly after it. */
	since?: number;
}

function concrete(theme: MarkTheme, token: ThemeColor): Color | undefined {
	try {
		return theme.colors?.[token];
	} catch {
		return undefined;
	}
}

/** `text` in `token` mixed toward `toward` by `amount`, or plain `token` when the theme has no concrete colours. */
function glow(theme: MarkTheme, token: ThemeColor, toward: Color | undefined, amount: number, text: string): string {
	const base = concrete(theme, token);
	if (!base || !toward || !theme.style || amount <= 0) return theme.fg(token, text);
	return theme.style(text, { fg: mixColors(base, toward, Math.min(1, amount)) });
}

/**
 * The mark of `state`, painted: `running` is a spinner frame, `waiting` breathes between its colour and `dim`, and a
 * fresh `done` glows and settles. In reduced motion every mark is its static glyph in its colour.
 */
export function stateMark(theme: MarkTheme, state: UiState, options: MarkOptions = {}): string {
	const reduced = animationClock.isReducedMotion();
	const now = options.now ?? Date.now();
	const color = STATE_COLOR[state];
	if (reduced) return theme.fg(color, GLYPH[state]);
	switch (state) {
		case "running": {
			const frames = SPINNER.braille;
			return theme.fg(color, frames[Math.floor(now / MOTION.spinnerMs) % frames.length]);
		}
		case "waiting":
			return glow(theme, color, concrete(theme, "dim"), 0.7 * breathe(now), GLYPH.waiting);
		case "done": {
			const left = options.since === undefined ? 0 : settle(now, options.since);
			const light = theme.appearance === "light" ? concrete(theme, "text") : rgbColor(255, 255, 255);
			return glow(theme, color, light, 0.65 * left, GLYPH.done);
		}
		default:
			return theme.fg(color, GLYPH[state]);
	}
}

/**
 * Whether a mark in `state` still moves at `now`: owners subscribe to the animation clock (`kind: "decor"`, every
 * `MOTION.spinnerMs` for running, `MOTION.glowFrameMs` otherwise) only while this holds, so a still screen writes nothing.
 */
export function markMoves(state: UiState, options: MarkOptions = {}): boolean {
	if (animationClock.isReducedMotion()) return false;
	if (state === "running" || state === "waiting") return true;
	if (state !== "done" || options.since === undefined) return false;
	return (options.now ?? Date.now()) - options.since < MOTION.flashMs;
}

/** The frame interval a moving mark needs. */
export function markFrameMs(state: UiState): number {
	return state === "running" ? MOTION.spinnerMs : MOTION.glowFrameMs;
}
