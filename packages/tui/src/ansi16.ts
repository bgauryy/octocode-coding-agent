import type { RgbColor } from "./terminal-colors.ts";

function distance(first: RgbColor, second: RgbColor): number {
	const dr = first.r - second.r;
	const dg = first.g - second.g;
	const db = first.b - second.b;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/** The 16 ANSI colors as most terminals draw them (xterm defaults): the target of the 16-color tier. */
const ANSI16_RGB: readonly RgbColor[] = [
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

/** The index (0-15) of the ANSI color closest to `color`. */
export function rgbToAnsi16(color: RgbColor): number {
	let best = 0;
	let bestDistance = Infinity;
	ANSI16_RGB.forEach((candidate, index) => {
		const gap = distance(color, candidate);
		if (gap < bestDistance) {
			best = index;
			bestDistance = gap;
		}
	});
	return best;
}

/** SGR parameter of ANSI color `index` (0-15): 30-37 and 90-97 for text, 40-47 and 100-107 for backgrounds. */
export function ansi16Code(index: number, background: boolean): number {
	return (index < 8 ? (background ? 40 : 30) : background ? 100 : 90) + (index % 8);
}
