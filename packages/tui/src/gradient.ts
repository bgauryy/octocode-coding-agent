import { backgroundAnsi, type Color, foregroundAnsi, mixColors, type TerminalColorMode } from "./colors.ts";
import { graphemeSegments, graphemeWidth, visibleWidth } from "./utils/width.ts";

export interface GradientOptions {
	/** Color at the start (`linear`) or at both ends (`center`). */
	from: Color;
	/** Color at the end (`linear`) or in the middle (`center`). */
	to: Color;
	mode: TerminalColorMode;
	/** Paint the text (default) or the cells behind it. */
	layer?: "foreground" | "background";
	/** `linear` (default): `from` to `to` left to right. `center`: `from` at both ends, `to` in the middle. */
	shape?: "linear" | "center";
}

/** Color steps a gradient is quantized to: neighbouring cells of one step share one escape sequence. */
const STEPS = 8;

/**
 * Whether two colors can blend in `mode`: truecolor or 256 colors, and neither a palette index. A palette color
 * follows the terminal's own palette, which a fixed mix would override, and 16 colors cannot show a blend at all.
 */
export function canBlendColors(from: Color, to: Color, mode: TerminalColorMode): boolean {
	return (mode === "truecolor" || mode === "256color") && from.kind !== "indexed" && to.kind !== "indexed";
}

/**
 * A painter for a static gradient across a run of plain text, or undefined when the colors cannot blend in `mode`
 * (see `canBlendColors`), so the caller keeps its flat style. The color steps are computed once here; painting is
 * one table lookup per cell. Text that already carries escape sequences gets the `from` color flat, since its own
 * codes would cut the ramp.
 */
export function createGradient(options: GradientOptions): ((text: string) => string) | undefined {
	const { from, to, mode } = options;
	if (!canBlendColors(from, to, mode)) return undefined;
	const paint = options.layer === "background" ? backgroundAnsi : foregroundAnsi;
	const close = options.layer === "background" ? "\x1b[49m" : "\x1b[39m";
	const codes = Array.from({ length: STEPS + 1 }, (_, step) =>
		paint(step === 0 ? from : step === STEPS ? to : mixColors(from, to, step / STEPS), mode),
	);
	const center = options.shape === "center";
	return (text) => {
		if (text.length === 0) return text;
		if (text.includes("\x1b")) return `${codes[0]}${text}${close}`;
		const last = Math.max(1, visibleWidth(text) - 1);
		let out = "";
		let current: string | undefined;
		let cell = 0;
		for (const char of graphemeSegments(text)) {
			const x = Math.min(1, cell / last);
			const code = codes[Math.round((center ? 1 - Math.abs(2 * x - 1) : x) * STEPS)];
			if (code !== current) {
				out += code;
				current = code;
			}
			out += char;
			cell += graphemeWidth(char);
		}
		return `${out}${close}`;
	};
}
