import { animationClock, type Component, ELLIPSIS, mixColors, shimmerText, Text } from "@octocodeai/octocode-tui";
import { formatDuration } from "../../../octocode/shared/format.ts";
import { stateMark } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** Reasoning shorter than this reads as `0s` or `1s` noise: the label omits the time. */
const MIN_SHOWN_MS = 1_000;

/** One timed thinking block: when it began, when its text last grew, and when the next block appeared. */
interface ThinkingSpan {
	chars: number;
	first?: number;
	last?: number;
	end?: number;
}

/**
 * Spans by block id, shared by every component that draws the block: the transcript may rebuild a message's component
 * when it completes, and the new one must still know how long the reasoning took. Oldest forgotten first.
 */
const spans = new Map<string, ThinkingSpan>();
const MAX_SPANS = 500;

/** Forget every span (tests). */
export function resetThinkingSpans(): void {
	spans.clear();
}

/**
 * Note that block `id` has `chars` of text at `now`. Only a block first seen while `streaming` is timed; one first seen
 * complete (a resumed session) stays unknown. `followed` is true once another block follows it.
 */
export function observeThinking(id: string, chars: number, followed: boolean, now: number, streaming: boolean): void {
	let span = spans.get(id);
	if (!span) {
		// A block first seen while streaming began now, even before its first token: a provider may deliver its whole
		// summary in one piece after the wait.
		span = { chars: 0, ...(streaming ? { first: now, last: now } : {}) };
		spans.set(id, span);
		if (spans.size > MAX_SPANS) spans.delete(spans.keys().next().value!);
	}
	if (chars > span.chars && span.first !== undefined) span.last = now;
	span.chars = chars;
	if (followed && span.end === undefined && span.last !== undefined) span.end = now;
}

/** How long a run of thinking blocks took, or undefined when unknown (a resumed session) or too short to say. */
export function thinkingMs(ids: readonly string[]): number | undefined {
	let total = 0;
	for (const id of ids) {
		const span = spans.get(id);
		if (span?.first === undefined) continue;
		total += (span.end ?? span.last ?? span.first) - span.first;
	}
	return total >= MIN_SHOWN_MS ? total : undefined;
}

/** ` · 4s`, or nothing when the time is unknown. */
export function durationSuffix(ms: number | undefined): string {
	return ms === undefined ? "" : ` · ${formatDuration(ms)}`;
}

/** The affordance of a hidden block: the bound key, and a click only where the terminal reports the mouse. */
export function revealHint(mouse: boolean): string {
	const key = keyText("app.thinking.toggle");
	if (key && mouse) return `(${key} or click)`;
	if (key) return `(${key})`;
	return mouse ? "(click to expand)" : "";
}

const ABORT_WORDING =
	/^(?:this operation was aborted|the operation was aborted|request was aborted|operation aborted|aborted)\.?$/i;

/** Whether a runtime abort message (`AbortError` text from fetch, a provider's own wording) says only that the user stopped. */
export function isAbortWording(message: string | undefined): boolean {
	return ABORT_WORDING.test(message?.trim() ?? "");
}

/** The one line for an interrupted turn: product wording for the runtime's, a specific message (retries) as it is. */
export function interruptedText(message: string | undefined): string {
	const text = message?.trim();
	return !text || isAbortWording(text) ? "Interrupted" : text;
}

/** The live label's text: the one word the working line also shows while the model reasons. */
export const THINKING_LABEL = `Thinking${ELLIPSIS}`;

/**
 * `text` with the light band the working line's verb has (`text` colour, peaking toward the accent), or in plain
 * `text` colour in reduced motion and in a theme without concrete colours.
 */
function shimmerLabel(text: string, now: number): string {
	try {
		const { colors } = theme;
		if (!animationClock.isReducedMotion() && colors.text && colors.accent) {
			const peak = mixColors(colors.text, colors.accent, theme.appearance === "light" ? 0.7 : 0.55);
			return shimmerText(text, { base: colors.text, peak, mode: theme.getColorMode(), now });
		}
	} catch {
		// A theme without concrete colours draws the label plain.
	}
	return theme.fg("text", text);
}

/**
 * The label of a reasoning block while it streams: the running spinner mark and `Thinking…` shimmering. It paints from
 * the clock at render time, so the owner only has to request a render per frame while the block streams.
 */
export class LiveThinkingLabel implements Component {
	/** When a frame last drew this label: an owner that is no longer on screen stops asking for frames. */
	renderedAt = Date.now();
	private readonly hint: string;
	private readonly padding: number;

	constructor(hint: string, padding: number) {
		this.hint = hint;
		this.padding = padding;
	}

	invalidate(): void {
		// Painted from the clock on every render; nothing cached.
	}

	render(width: number): string[] {
		const now = Date.now();
		this.renderedAt = now;
		const hint = this.hint ? theme.fg("dim", ` ${this.hint}`) : "";
		return new Text(
			`${stateMark(theme, "running", { now })} ${shimmerLabel(THINKING_LABEL, now)}${hint}`,
			this.padding,
			0,
		).render(width);
	}
}
