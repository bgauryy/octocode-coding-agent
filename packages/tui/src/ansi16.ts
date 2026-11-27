import { rgbToOklab } from "./oklab.ts";
import type { RgbColor } from "./terminal-colors.ts";

/**
 * The 16 ANSI colors as most terminals draw them (xterm defaults): the target of the 16-color tier, and the RGB of
 * indexed colors 0-15 everywhere else (`colors.ts`), so both read one palette.
 */
export const ANSI16_RGB: readonly RgbColor[] = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
].map(([r, g, b]) => ({ r, g, b }));

const CHROMATIC = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14] as const;
const GRAYS = [0, 7, 8, 15] as const;
const ANSI16_LAB = ANSI16_RGB.map((rgb) => rgbToOklab(rgb));
const ANSI16_HUE = ANSI16_LAB.map(([, a, b]) => Math.atan2(b, a));
/** Below this OKLab chroma a color reads as gray: it maps to the nearest gray by lightness. */
const GRAY_CHROMA = 0.04;
/**
 * A hue gap of 30° costs as much as a lightness gap of 0.5: terminals vary the lightness of their 16 colors more than
 * their hue, and a status color must keep its hue (a pastel red stays red, never the gray a plain RGB distance picks).
 */
const HUE_STEP = Math.PI / 6;
const LIGHTNESS_STEP = 0.5;

function nearest(indexes: readonly number[], cost: (index: number) => number): number {
	let best = indexes[0];
	let bestCost = cost(best);
	for (const index of indexes) {
		const next = cost(index);
		if (next < bestCost) {
			best = index;
			bestCost = next;
		}
	}
	return best;
}

/** The index (0-15) of the ANSI color closest to `color`: grays by lightness, other colors by hue first. */
export function rgbToAnsi16(color: RgbColor): number {
	const [l, a, b] = rgbToOklab(color);
	if (Math.hypot(a, b) < GRAY_CHROMA) return nearest(GRAYS, (index) => Math.abs(ANSI16_LAB[index][0] - l));
	const hue = Math.atan2(b, a);
	return nearest(CHROMATIC, (index) => {
		const gap = Math.abs(hue - ANSI16_HUE[index]);
		const turn = Math.min(gap, 2 * Math.PI - gap) / HUE_STEP;
		return turn * turn + ((l - ANSI16_LAB[index][0]) / LIGHTNESS_STEP) ** 2;
	});
}

/** SGR parameter of ANSI color `index` (0-15): 30-37 and 90-97 for text, 40-47 and 100-107 for backgrounds. */
export function ansi16Code(index: number, background: boolean): number {
	return (index < 8 ? (background ? 40 : 30) : background ? 100 : 90) + (index % 8);
}
