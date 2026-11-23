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
 * The colour role of each state on the state light (`MarkOptions.light`, the mark of tool, agent and work rows and of
 * every activity light): green while it works (the `LIGHT_FRAMES` spinner, or a steady ⏺ where it cannot move) and
 * when done (✓), yellow when it needs the user (◇), red when it failed (✗) or was stopped (◼), dim when idle or queued
 * (○). It differs from `STATE_COLOR` where `running` is `success` (green means alive; the accent spinner stays the main
 * working line's) and `stopped` is `error`.
 */
export const LIGHT_COLOR = {
	...STATE_COLOR,
	running: "success",
	stopped: "error",
} as const satisfies Readonly<Record<UiState, ThemeColor>>;

/**
 * The frames of a running state light where it moves: the main working spinner's (`SPINNER.braille`), in the light's
 * green. Where a light cannot move (a still list, the footer, `+N more`, reduced motion) a running light is a full
 * steady ⏺ instead: never a frame of a spinner held still, which reads as half done.
 */
export const LIGHT_FRAMES = SPINNER.braille;

/**
 * The light's glyph for a state drawn still: a full ⏺ for running, and only for running; every settled state draws
 * its own glyph (`○ ◇ ✓ ✗ ◼`), in colour and without, so a still running light never looks like a done one.
 */
function lightGlyph(state: UiState): string {
	return state === "running" ? GLYPH.light : GLYPH[state];
}

/**
 * The state light drawn still, for places that never animate (the footer, a `+N more` count, a list): one cell in
 * `LIGHT_COLOR`, the shape of `lightGlyph`.
 */
export function stillLight(theme: Pick<MarkTheme, "fg" | "getColorMode">, state: UiState): string {
	return theme.fg(LIGHT_COLOR[state], lightGlyph(state));
}

/** The colour of an activity light's word: loud only when it asks for the user or reports a failure. */
const ACTIVITY_WORD: Readonly<Partial<Record<UiState, ThemeColor>>> = {
	running: "muted",
	waiting: "warning",
	failed: "error",
};

/**
 * An activity light (`activity` of the application projections: one state of running, waiting, failed or pending, and
 * a word) drawn still: `⏺ needs you`, the word in warning or error when it asks for attention, else quiet. `word: false`
 * draws the light alone.
 */
export function activityMark(
	theme: Pick<MarkTheme, "fg" | "getColorMode">,
	shown: { state: UiState; label: string },
	word = true,
): string {
	const light = stillLight(theme, shown.state);
	return word ? `${light} ${activityWord(theme, shown)}` : light;
}

/** An activity light's word alone, painted as `activityMark` paints it. */
export function activityWord(theme: Pick<MarkTheme, "fg">, shown: { state: UiState; label: string }): string {
	return theme.fg(ACTIVITY_WORD[shown.state] ?? "dim", shown.label);
}

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
	/** The theme's colour mode (`none` is NO_COLOR); the light's glyphs are the same in every mode. */
	getColorMode?(): string;
}

export interface MarkOptions {
	/** Frame time (default now). */
	now?: number;
	/** When the state was entered: a `done` mark glows briefly after it. */
	since?: number;
	/** A mark of work running in the background: it spins at `MOTION.backgroundSpinnerMs`, its owner repaints at that pace. */
	background?: boolean;
	/** Draw the state light (the `LIGHT_FRAMES` spinner, or a still ⏺, while `running`; each settled state's own glyph, in `LIGHT_COLOR`) instead of the state's glyph and spinner. */
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
const WAIT_PULSE_MS = 4_000;

/**
 * The mark of `state`, painted: `running` is a spinner frame, `waiting` breathes between its colour and `dim`, and a
 * fresh `done` glows and settles. In reduced motion every mark is its static glyph in its colour.
 */
export function stateMark(theme: MarkTheme, state: UiState, options: MarkOptions = {}): string {
	const reduced = animationClock.isReducedMotion();
	const now = options.now ?? animationClock.decorationTime();
	if (options.light) return lightMark(theme, state, options, reduced);
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

/** The state light: the working spinner while `running` (a full ⏺ in reduced motion), the state's steady glyph otherwise. */
function lightMark(theme: MarkTheme, state: UiState, options: MarkOptions, reduced: boolean): string {
	const color = LIGHT_COLOR[state];
	if (state !== "running" || reduced) return stillLight(theme, state);
	const frame = Math.floor((options.now ?? animationClock.frameTime()) / markFrameMs(state, { light: true }));
	return theme.fg(color, LIGHT_FRAMES[frame % LIGHT_FRAMES.length]);
}

/**
 * Whether a mark in `state` still moves at `now`: owners subscribe to the animation clock (`kind: "decor"`, at `markFrameMs`) only while this holds, so a still screen writes nothing.
 */
export function markMoves(state: UiState, options: MarkOptions = {}): boolean {
	if (animationClock.isReducedMotion()) return false;
	if (state === "running") return true;
	if (options.light) return false;
	// A modal can wait indefinitely: the pulse draws the eye for a few seconds, then the mark holds still.
	if (state === "waiting")
		return options.since === undefined || (options.now ?? Date.now()) - options.since < WAIT_PULSE_MS;
	if (state !== "done" || options.since === undefined) return false;
	return (options.now ?? Date.now()) - options.since < MOTION.flashMs;
}

/** A running mark's spinner frame interval: slower for work in the background (see `MarkOptions.background`). */
const spinnerMs = (background = false): number => (background ? MOTION.backgroundSpinnerMs : MOTION.spinnerMs);

/**
 * The frame interval a moving mark needs. A running light can spin for hours, so it repaints at the background pace
 * (never faster than `MOTION.glowFrameMs`) wherever it is drawn.
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
