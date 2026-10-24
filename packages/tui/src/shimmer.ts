import { type Color, foregroundAnsi, mixColors, type TerminalColorMode } from "./colors.ts";
import { visibleWidth } from "./utils/width.ts";

export interface ShimmerOptions {
	/** Color of the text outside the band. */
	base: Color;
	/** Color at the center of the band. */
	peak: Color;
	mode: TerminalColorMode;
	/** Time of the frame, in milliseconds (default `Date.now()`); every shimmer on one clock moves in step. */
	now?: number;
	/** How long the band takes to cross the text and its padding (default 2000). */
	periodMs?: number;
	/** Half the band's width, in cells (default 5). */
	halfWidth?: number;
	/** Cells the band travels before and after the text, so it enters and leaves smoothly (default 10). */
	padding?: number;
}

/** Brightness steps a band is quantized to: neighbouring cells of one step share one escape sequence. */
const STEPS = 8;

/**
 * `text` painted with a soft light band sweeping left to right: each cell's color is `base` mixed toward `peak` by
 * a cosine falloff from the band's center. `text` must be plain (no escape sequences). Wide characters count as
 * their cell width.
 */
export function shimmerText(text: string, options: ShimmerOptions): string {
	if (text.length === 0) return text;
	const { base, peak, mode } = options;
	const periodMs = Math.max(1, options.periodMs ?? 2000);
	const halfWidth = Math.max(1, options.halfWidth ?? 5);
	const padding = Math.max(0, options.padding ?? 10);
	const width = visibleWidth(text);
	const span = width + 2 * padding;
	const phase = (((options.now ?? Date.now()) % periodMs) + periodMs) % periodMs;
	const center = (phase / periodMs) * span - padding;
	const ansi = new Map<number, string>();
	let out = "";
	let current: string | undefined;
	let cell = 0;
	for (const char of text) {
		const distance = Math.abs(cell + 0.5 - center);
		const glow = distance >= halfWidth ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / halfWidth));
		const step = Math.round(glow * STEPS);
		let code = ansi.get(step);
		if (code === undefined) {
			code = foregroundAnsi(step === 0 ? base : mixColors(base, peak, step / STEPS), mode);
			ansi.set(step, code);
		}
		if (code !== current) {
			out += code;
			current = code;
		}
		out += char;
		cell += visibleWidth(char);
	}
	return `${out}\x1b[39m`;
}
