import {
	animationClock,
	breathe,
	type Color,
	GLYPH,
	MOTION,
	mixColors,
	shimmerText,
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
	/** A mark of work running in the background: it spins at `MOTION.backgroundSpinnerMs`, its owner repaints at that pace. */
	background?: boolean;
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

/** How long a waiting mark pulses (from its `since`) before it holds still. */
export const WAIT_PULSE_MS = 4_000;

/**
 * The mark of `state`, painted: `running` is a spinner frame, `waiting` breathes between its colour and `dim`, and a
 * fresh `done` glows and settles. In reduced motion every mark is its static glyph in its colour.
 */
export function stateMark(theme: MarkTheme, state: UiState, options: MarkOptions = {}): string {
	const reduced = animationClock.isReducedMotion();
	const now = options.now ?? animationClock.decorationTime();
	const color = STATE_COLOR[state];
	if (reduced) return theme.fg(color, GLYPH[state]);
	switch (state) {
		case "running": {
			const frames = SPINNER.braille;
			return theme.fg(color, frames[Math.floor(now / spinnerMs(options.background)) % frames.length]);
		}
		case "waiting":
			if (options.since !== undefined && now - options.since >= WAIT_PULSE_MS) return theme.fg(color, GLYPH.waiting);
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
	if (state === "running") return true;
	// A modal can wait indefinitely: the pulse draws the eye for a few seconds, then the mark holds still.
	if (state === "waiting")
		return options.since === undefined || (options.now ?? Date.now()) - options.since < WAIT_PULSE_MS;
	if (state !== "done" || options.since === undefined) return false;
	return (options.now ?? Date.now()) - options.since < MOTION.flashMs;
}

/** A running mark's spinner frame interval: slower for work in the background (see `MarkOptions.background`). */
export const spinnerMs = (background = false): number => (background ? MOTION.backgroundSpinnerMs : MOTION.spinnerMs);

/** The frame interval a moving mark needs. */
export function markFrameMs(state: UiState, background = false): number {
	return state === "running" ? spinnerMs(background) : MOTION.glowFrameMs;
}

/** What `liveShimmer` needs from a theme: concrete colours and their colour mode. */
export interface ShimmerTheme {
	fg(color: ThemeColor, text: string): string;
	readonly colors: Readonly<Partial<Record<string, Color>>>;
	readonly appearance?: "dark" | "light";
	getColorMode(): Parameters<typeof shimmerText>[1]["mode"];
}

/**
 * `text` with the light band the working line's verb has: `text` colour peaking toward the accent. It is plain `text`
 * colour in reduced motion and in a theme without concrete colours, so every live label dims the same way.
 */
export function liveShimmer(theme: ShimmerTheme, text: string, now?: number): string {
	try {
		const { text: base, accent } = theme.colors;
		if (!animationClock.isReducedMotion() && base && accent) {
			const peak = mixColors(base, accent, theme.appearance === "light" ? 0.7 : 0.55);
			return shimmerText(text, { base, peak, mode: theme.getColorMode(), ...(now === undefined ? {} : { now }) });
		}
	} catch {
		// A theme without concrete colours draws the text plain.
	}
	return theme.fg("text", text);
}
