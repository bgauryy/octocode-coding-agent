import { scaledByWindow } from "../shared/window-scale.ts";

/**
 * The one length every note-sized text is held to: an injected line is cut at it, a saved memory body over it is warned
 * about, and a session note's body may be a few times longer (a note is sent whole until an injected line cuts it). It
 * does not grow with the window: a memory outlives the model it was written with, and a line cut differently per model
 * would show it whole to one and cut to another.
 */
export const NOTE_CHARS = 600;
/** Characters of a line that are not the body (label, tags, title), so a warned body still fits a line. */
const LINE_OVERHEAD = 100;
/** A body longer than this is kept but warned about. */
export const NOTE_WARN_CHARS = NOTE_CHARS - LINE_OVERHEAD;
/** The longest body a session note keeps. */
export const SESSION_NOTE_BODY_MAX = Math.floor((NOTE_CHARS * 10) / 3);
/**
 * Characters of memory lines per injection, of the whole injected message, and of session-note lines: floors that grow
 * with the model's window (`shared/window-scale.ts`), so a large window carries more notes, each held to `NOTE_CHARS`.
 */
const PINNED_BUDGET_FLOOR = 1200;
const TOTAL_BUDGET_FLOOR = 2400;
const SESSION_BUDGET_FLOOR = 1600;

export const pinnedBudget = (contextWindow?: number): number => scaledByWindow(PINNED_BUDGET_FLOOR, contextWindow);
export const totalBudget = (contextWindow?: number): number => scaledByWindow(TOTAL_BUDGET_FLOOR, contextWindow);
export const sessionBudget = (contextWindow?: number): number => scaledByWindow(SESSION_BUDGET_FLOOR, contextWindow);
