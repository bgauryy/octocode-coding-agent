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
	stopped: "warning",
} as const satisfies Readonly<Record<UiState, ThemeColor>>;

/**
 * The colour role of each state on the state light (`MarkOptions.light`, the ⏺ of agent and work rows): green while it
 * works, yellow when it needs the user, red when it failed or was stopped, dim when idle or gone. It differs from
 * `STATE_COLOR` only where the light reads at a glance: `running` is `success` (the spinner stays `accent`) and
 * `stopped` is `error`.
 */
export const LIGHT_COLOR = {
	...STATE_COLOR,
	running: "success",
	stopped: "error",
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
	/** Draw the state light (⏺ in `LIGHT_COLOR`, breathing while `running`) instead of the state's glyph and spinner. */
	light?: boolean;
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
	if (options.light) return lightMark(theme, state, options, reduced, now);
	const color = STATE_COLOR[state];
	if (reduced) return theme.fg(color, GLYPH[state]);
	switch (state) {
		case "running": {
			const frames = SPINNER.braille;
			return theme.fg(
				color,
				frames[Math.floor((options.now ?? animationClock.frameTime()) / spinnerMs(options.background)) % frames.length],
			);
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

/** The brightest the breathing light of a running mark gets toward the light colour (0..1). */
const LIGHT_BREATH = 0.6;

/** The lit ⏺: `running` breathes toward the light colour, `waiting` pulses then holds, `done` settles; the rest are steady. */
function lightMark(theme: MarkTheme, state: UiState, options: MarkOptions, reduced: boolean, now: number): string {
	const color = LIGHT_COLOR[state];
	if (reduced) return theme.fg(color, GLYPH.light);
	const toward = theme.appearance === "light" ? concrete(theme, "text") : rgbColor(255, 255, 255);
	switch (state) {
		case "running":
			return glow(theme, color, toward, LIGHT_BREATH * breathe(now), GLYPH.light);
		case "waiting":
			if (options.since !== undefined && now - options.since >= WAIT_PULSE_MS) return theme.fg(color, GLYPH.light);
			return glow(theme, color, concrete(theme, "dim"), 0.7 * breathe(now), GLYPH.light);
		case "done":
			return glow(
				theme,
				color,
				toward,
				0.65 * (options.since === undefined ? 0 : settle(now, options.since)),
				GLYPH.light,
			);
		default:
			return theme.fg(color, GLYPH.light);
	}
}

/**
 * Whether a mark in `state` still moves at `now`: owners subscribe to the animation clock (`kind: "decor"`, at `markFrameMs`) only while this holds, so a still screen writes nothing.
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
const spinnerMs = (background = false): number => (background ? MOTION.backgroundSpinnerMs : MOTION.spinnerMs);

/**
 * The frame interval a moving mark needs. A running light breathes slowly and can burn for hours, so it repaints at
 * the background pace (never faster than `MOTION.glowFrameMs`) wherever it is drawn.
 */
export function markFrameMs(state: UiState, options: Pick<MarkOptions, "background" | "light"> = {}): number {
	if (state !== "running") return MOTION.glowFrameMs;
	return options.light ? Math.max(MOTION.glowFrameMs, MOTION.backgroundSpinnerMs) : spinnerMs(options.background);
}

/** What `liveShimmer` needs from a theme: concrete colours and their colour mode. */
export interface ShimmerTheme {
	fg(color: ThemeColor, text: string): string;
	readonly colors: Readonly<Partial<Record<string, Color>>>;
	/** The terminal's default colors: the shimmer runs between them. */
	readonly terminalDefaults?: { readonly foreground: Color; readonly background: Color };
	readonly appearance?: "dark" | "light";
	getColorMode(): Parameters<typeof shimmerText>[1]["mode"];
}

/** How far the resting colour of a shimmer sits from the terminal's foreground toward its background. */
const SHIMMER_REST = 0.45;

/**
 * `text` with the light band every live label shares: the terminal's foreground, dimmed toward its background at rest
 * and full at the band's centre (a theme without the terminal's colours uses its `text` peaking toward the accent;
 * 16 colors use dim and bold). It is plain `text` colour in reduced motion and in a theme without concrete colours.
 */
export function liveShimmer(theme: ShimmerTheme, text: string, now?: number): string {
	try {
		const { text: base, accent } = theme.colors;
		const defaults = theme.terminalDefaults;
		if (!animationClock.isReducedMotion() && defaults) {
			const { foreground, background } = defaults;
			const rest = mixColors(foreground, background, SHIMMER_REST);
			return shimmerText(text, {
				base: rest,
				peak: foreground,
				mode: theme.getColorMode(),
				...(now === undefined ? {} : { now }),
			});
		}
		if (!animationClock.isReducedMotion() && base && accent) {
			const peak = mixColors(base, accent, theme.appearance === "light" ? 0.7 : 0.55);
			return shimmerText(text, { base, peak, mode: theme.getColorMode(), ...(now === undefined ? {} : { now }) });
		}
	} catch {
		// A theme without concrete colours draws the text plain.
	}
	return theme.fg("text", text);
}
