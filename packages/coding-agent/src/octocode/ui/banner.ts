import { truncateToWidth } from "@octocodeai/octocode-tui";

/**
 * The "OCTOCODE AGENT" header: two rows of half-block art and the beta notice. Pure in (paint, width, reveal): the header
 * sits at the top of the scrollback, where any changed row makes the terminal renderer clear and redraw everything, so it
 * changes only when the width or theme does, and for the one-time reveal at a fresh start (`reveal`, while the scrollback
 * holds nothing else). Its height is the same at every width; a terminal
 * narrower than the art gets the plain name in its place. Strokes run along a left-to-right gradient from the theme.
 */

export interface BannerPaint {
	/** Text in a theme colour token (`accent`, `muted`, `dim`, …). */
	fg(token: string, text: string): string;
	/** Text at gradient position `t` (0 = left edge, 1 = right edge). Without it each word takes one theme colour. */
	ramp?(t: number, text: string): string;
}

const BANNER_ART = [
	"█▀█ █▀▀ ▀█▀ █▀█ █▀▀ █▀█ █▀▄ █▀▀   ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀",
	"█▄█ █▄▄  █  █▄█ █▄▄ █▄█ █▄▀ ██▄   █▀█ █▄█ ██▄ █ ▀█  █ ",
] as const;
export const ISSUES_URL = "https://github.com/bgauryy/octocodecode/issues";
/** Every art character is one cell wide and one UTF-16 unit long. */
const ART_WIDTH = BANNER_ART[0].length;
/** Column where "AGENT" starts, for the per-word fallback colours. */
const SPLIT = BANNER_ART[0].indexOf("   ") + 3;
/** Gradient steps: neighbouring cells of one step share one escape sequence. */
const STEPS = 32;

/** One art line, cut into runs that share a paint. */
function paintArt(paint: BannerPaint, line: string, revealed = line.length): string {
	let out = "";
	let run = "";
	let key = "";
	let style: ((text: string) => string) | undefined;
	const flush = () => {
		if (run) out += style ? style(run) : run;
		run = "";
	};
	for (let column = 0; column < line.length; column++) {
		// Columns the reveal has not reached stay blank: the art keeps its height and width while it appears.
		const char = column < revealed ? line[column] : " ";
		let nextKey = " ";
		let nextStyle: ((text: string) => string) | undefined;
		if (char !== " ") {
			if (paint.ramp) {
				const t = Math.round((column / (ART_WIDTH - 1)) * STEPS) / STEPS;
				nextKey = `t:${t}`;
				nextStyle = (text) => paint.ramp!(t, text);
			} else {
				const color = column < SPLIT ? "accent" : "mdLink";
				nextKey = color;
				nextStyle = (text) => paint.fg(color, text);
			}
		}
		if (nextKey !== key) {
			flush();
			key = nextKey;
			style = nextStyle;
		}
		run += char;
	}
	flush();
	return out;
}

/** `status` (painted): one more line under the notice, such as the backlog counts (`backlog-status.ts`). */
export function bannerLines(
	paint: BannerPaint,
	width: number,
	status?: (paint: BannerPaint) => string | undefined,
	/** How much of the art shows, 0..1 (default all): a left-to-right wipe. The notice appears with the last column. */
	reveal = 1,
): string[] {
	const revealed = Math.ceil(Math.min(1, Math.max(0, reveal)) * ART_WIDTH);
	const art =
		width >= ART_WIDTH
			? BANNER_ART.map((line) => paintArt(paint, line, revealed))
			: [`${paint.fg("accent", "OCTOCODE")} ${paint.fg("mdLink", "AGENT")}`, ""];
	const notice = `${paint.fg("warning", "BETA version")} ${paint.fg("muted", "; please assign issues here")} ${paint.fg("mdLink", ISSUES_URL)}`;
	// Every line must fit the width, however narrow the terminal.
	const extra = status?.(paint);
	const settled = reveal >= 1;
	// Until the art is whole the notice and the status line are blank rows, so the height never changes.
	return [...art, settled ? notice : "", ...(extra ? [settled ? extra : ""] : [])].map((line) =>
		truncateToWidth(line, Math.max(1, width), ""),
	);
}
