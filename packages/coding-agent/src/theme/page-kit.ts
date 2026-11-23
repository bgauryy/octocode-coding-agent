/**
 * The shared pieces of every terminal page: the status badge and its legend, the key-hint vocabulary, the one
 * scroll window with its position label, and the named-outcome prompt. Pure functions: no I/O, no page state.
 */

import { GLYPH } from "@octocodeai/octocode-tui";
import { keyText, type RankedHint } from "./theme-tui-helpers.ts";

// ── Status badge ────────────────────────────────────────────────────────────────────────────────────────────────

export type BadgeState = "ready" | "attention" | "broken" | "off";
type BadgeTone = "success" | "warning" | "error" | "muted";

export interface Badge {
	glyph: string;
	word: string;
	tone: BadgeTone;
	/** `✓ ready`: the glyph and the word together, so no state rests on color alone. */
	text: string;
}

const BADGES: Record<BadgeState, { glyph: string; word: string; tone: BadgeTone }> = {
	ready: { glyph: "✓", word: "ready", tone: "success" },
	attention: { glyph: "⚠", word: "needs action", tone: "warning" },
	broken: { glyph: "✗", word: "broken", tone: "error" },
	// Not `○`: that is the idle and queued state's glyph without colour, and a page badge never shares a light's glyph.
	off: { glyph: "∅", word: "off", tone: "muted" },
};

/** The one state → glyph, word and tone table. Throws on a state it does not know. */
export function badge(state: BadgeState): Badge {
	const entry = BADGES[state];
	if (!entry) throw new Error(`Unknown badge state: ${state}`);
	return { ...entry, text: `${entry.glyph} ${entry.word}` };
}

/** An agent's or session's activity (the tones of the application projections' `activity`). */
export type ActivityBadgeTone = "working" | "waiting" | "error" | "idle";

/** The activity lights as page badges: each tone its light's colour and its state's own glyph, with a word. */
const ACTIVITY_BADGES: Record<ActivityBadgeTone, { glyph: string; word: string; tone: BadgeTone }> = {
	// A list is still: a working light is the full ⏺, never a spinner frame held still.
	working: { glyph: GLYPH.light, word: "working", tone: "success" },
	waiting: { glyph: GLYPH.waiting, word: "needs you", tone: "warning" },
	error: { glyph: GLYPH.failed, word: "failed", tone: "error" },
	idle: { glyph: GLYPH.pending, word: "idle", tone: "muted" },
};

/** The badge of an activity: `⏺ working`, `◇ needs you`, `✗ failed`, `○ idle`. `word` replaces the default word. */
export function activityBadge(tone: ActivityBadgeTone, word?: string): Badge {
	const entry = ACTIVITY_BADGES[tone];
	if (!entry) throw new Error(`Unknown activity: ${tone}`);
	const shown = word ?? entry.word;
	return { ...entry, word: shown, text: `${entry.glyph} ${shown}` };
}

/** One plain line naming only the states on screen, once each, in the order given: `✓ ready  ⚠ needs action`. */
export function legend(states: readonly BadgeState[]): string {
	return [...new Set(states)].map((state) => badge(state).text).join("  ");
}

// ── Key hints ───────────────────────────────────────────────────────────────────────────────────────────────────

export type PageKind = "list" | "detail" | "picker" | "form";

/** What Enter does on a page: the only verbs a page footer may use. */
export type EnterVerb =
	| "open"
	| "run"
	| "select"
	| "toggle"
	| "inspect"
	| "edit"
	| "confirm"
	| "review"
	| "submit"
	| "close";

export interface PageHintContext {
	/** The page was opened from another page: Escape goes `back`; at the root it `close`s. */
	nested: boolean;
	/** The keys of the highlighted row (key → verb). Only these appear; a page-level key the row lacks is not shown. */
	rowKeys?: Readonly<Record<string, string>>;
	/** Enter's verb; defaults by kind. `false`: Enter does nothing (an empty list, a scrolling view). */
	enter?: EnterVerb | false;
	/** Navigation keys the page owns beyond the vocabulary (`←/→ section`), shown after Enter. */
	extras?: readonly RankedHint[];
	/** An alternative key that also goes back, shown with Escape (`f2/esc back`). */
	escAlias?: string;
	/** Key texts when the page holds its own keybindings; defaults to the active ones. */
	confirmKey?: string;
	cancelKey?: string;
}

const DEFAULT_ENTER: Record<PageKind, EnterVerb> = { list: "open", detail: "run", picker: "select", form: "submit" };

/**
 * The key hints of a page footer: Enter first, the page's own navigation, the highlighted row's keys, Escape last
 * (`esc back` when nested, `esc close` at the root). Narrow terminals drop the least important hints first.
 */
export function pageHints(kind: PageKind, ctx: PageHintContext): RankedHint[] {
	const hints: RankedHint[] = [];
	const verb = ctx.enter ?? DEFAULT_ENTER[kind];
	if (verb) hints.push([ctx.confirmKey ?? keyText("tui.select.confirm"), verb, 0]);
	for (const hint of ctx.extras ?? []) hints.push(hint);
	for (const [key, label] of Object.entries(ctx.rowKeys ?? {})) hints.push([key, label, 1]);
	const cancel = ctx.cancelKey ?? keyText("tui.select.cancel");
	hints.push([ctx.escAlias ? `${ctx.escAlias}/${cancel}` : cancel, ctx.nested ? "back" : "close", 0]);
	return hints;
}

// ── Scroll window ───────────────────────────────────────────────────────────────────────────────────────────────

/** The `[start, end)` slice of `total` items, at most `max` long, that keeps `selected` near the middle. */
export function windowList(total: number, selected: number, max: number): { start: number; end: number } {
	const start = Math.max(0, Math.min(selected - Math.floor(max / 2), total - max));
	return { start, end: Math.min(start + max, total) };
}

/** `1–20/48`: the visible span of a scrolling list, the one position label of every screen. */
export function positionLabel(first: number, last: number, total: number): string {
	return first === last ? `${first}/${total}` : `${first}–${last}/${total}`;
}

// ── Named-outcome prompt ────────────────────────────────────────────────────────────────────────────────────────

export interface ChoiceOption<T = string> {
	/** What the user reads: a named outcome (`Use for this chat`), never `OK`. */
	label: string;
	value: T;
	/** The outcome outlives this session (a saved default, a written file). */
	persistent?: boolean;
}

export interface Choice<T = string> {
	title: string;
	labels: string[];
	/** The option whose label the user picked; undefined when they cancelled. */
	pick(label: string | undefined): ChoiceOption<T> | undefined;
}

/**
 * A prompt whose options each name their outcome. The first option is what a bare Enter picks, so it must not be a
 * persistent one; this throws if it is. Show `labels` under `title` with any selector, then call `pick`.
 */
export function choice<T>(title: string, options: readonly ChoiceOption<T>[]): Choice<T> {
	if (options.length === 0) throw new Error(`Choice "${title}" has no options`);
	if (options[0].persistent) throw new Error(`Choice "${title}": a persistent option cannot be the default`);
	const labels = options.map((option) => option.label);
	if (new Set(labels).size !== labels.length) throw new Error(`Choice "${title}" repeats a label`);
	return {
		title,
		labels,
		pick: (label) => options.find((option) => option.label === label),
	};
}
