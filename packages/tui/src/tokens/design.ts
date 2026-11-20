/**
 * The terminal design language shared by every surface: one mark per state, one spinner, one ellipsis, one set of
 * motion timings. Pure data: colours stay in the host's theme, which maps each state to a colour role.
 */

/** The six states a tool, agent, question or run can be in. */
export type UiState = "pending" | "running" | "waiting" | "done" | "failed" | "stopped";

/** Spinner frame sets. `braille` is the default; `quadrant` is for terminals that draw braille too narrow. */
export const SPINNER = {
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	quadrant: ["◐", "◓", "◑", "◒"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Marks. A state has exactly one glyph (`running` animates through `SPINNER.braille`; `GLYPH.running` is its static
 * mark, a hollow dotted circle shown whenever motion is still); presence and structure marks never stand for a state.
 */
export const GLYPH = {
	pending: "○",
	running: "◌",
	waiting: "◇",
	done: "✓",
	failed: "✗",
	stopped: "◼",
	/** Presence: a live session or connected server, never a state. */
	live: "●",
	message: "✉",
	warning: "⚠",
	turn: "✻",
	collapsed: "▸",
	expanded: "▾",
	cursor: "›",
	gutter: "⎿",
	reason: "↳",
	/** Leads a line of notes under a card: what the system adds about an action. Not a fold marker. */
	note: "▸",
	/** From one value to another (`A → B`), a state change or a question's answer. */
	arrow: "→",
	userBar: "▎",
	/** The state light: one dot every state shares, coloured by `LIGHT_COLOR` and lit while it runs (agent rows, work rows). */
	light: "⏺",
} as const;

/** Glyph marks: one cell wide in common terminals, none shared with a `GLYPH` state mark; the theme colours them. */
const TONE_GLYPH = { calm: "≋", caution: "▲", problem: "◆" } as const;
/** Sea emoji: the opt-in branding for the same three tones. */
const TONE_EMOJI = { calm: "🐚", caution: "🦀", problem: "🦈" } as const;
/** The mark of the main session in a terminal title. */
const TITLE_GLYPH = "◈";
const TITLE_EMOJI = "🦑";

let emojiMarks = false;

/** Whether tone marks and the terminal title use emoji (width varies by terminal) instead of glyphs. Off by default. */
export function setEmojiMarks(enabled: boolean): void {
	emojiMarks = enabled;
}

/** The main session's mark in a terminal title: a glyph, or the squid emoji when emoji marks are on. */
export function titleMark(): string {
	return emojiMarks ? TITLE_EMOJI : TITLE_GLYPH;
}

/**
 * Marks for the tone of a notice, shown beside its state glyph and never instead of it: `calm` good news or a plain
 * note, `caution` a warning or trade-off, `problem` an error or risk. Read at use, so `setEmojiMarks` reaches them.
 */
export const TONE = {
	get calm(): string {
		return emojiMarks ? TONE_EMOJI.calm : TONE_GLYPH.calm;
	},
	get caution(): string {
		return emojiMarks ? TONE_EMOJI.caution : TONE_GLYPH.caution;
	},
	get problem(): string {
		return emojiMarks ? TONE_EMOJI.problem : TONE_GLYPH.problem;
	},
};

/** The one ellipsis, and the one separator between items on a line. */
export const ELLIPSIS = "…";
export const SEPARATOR = " · ";

/** Motion timings, in milliseconds. */
export const MOTION = {
	/** Spinner frame interval. */
	spinnerMs: 80,
	/**
	 * Spinner frame interval of work running in the background (the team panel's agents and jobs). These rows can spin
	 * for hours while nothing else moves; every frame repaints the terminal, and terminals that render rows as DOM
	 * (VS Code with GPU acceleration off, screen-reader mode) pay for each one. The foreground keeps `spinnerMs`.
	 */
	backgroundSpinnerMs: 200,
	/** A light band crossing a live label (thinking, the working verb). */
	shimmerPeriodMs: 2_000,
	/** One in-and-out breath of a mark that waits on the user. */
	breathePeriodMs: 1_600,
	/** How long a just-finished mark glows before it settles. */
	flashMs: 450,
	/** Frame interval of breathe and flash: smooth enough, a tenth of the spinner's wakeups. */
	glowFrameMs: 100,
	/** Step of decoration while the terminal is unfocused: it keeps moving, slowly, so a background session still looks alive. */
	unfocusedDecorMs: 500,
	/** Elapsed-time counters. */
	tickMs: 1_000,
} as const;

/** 0..1..0 over `periodMs`: a smooth breath (raised cosine), 0 at the start of each period. */
export function breathe(now: number, periodMs: number = MOTION.breathePeriodMs): number {
	const phase = (((now % periodMs) + periodMs) % periodMs) / periodMs;
	return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
}

/** 1 at `since`, easing to 0 after `durationMs` (ease-out): how much a just-finished mark still glows. */
export function settle(now: number, since: number, durationMs: number = MOTION.flashMs): number {
	const t = Math.min(1, Math.max(0, (now - since) / durationMs));
	return (1 - t) * (1 - t);
}
