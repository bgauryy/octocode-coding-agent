import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";

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
	/** Text at gradient position `t` (0 = left edge, 1 = right edge), with optional `glow` (0..1) highlight boost. */
	ramp?(t: number, text: string, glow?: number): string;
	/** Typing cursor glyph painted at the leading column while the reveal is in progress. */
	cursor?(glyph: string): string;
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
/** Leading-edge trail width (in columns) that glows bright behind the typing cursor. */
const TYPE_TRAIL = 3;
/** Half-width (in normalized 0..1 coordinates) of the post-typing shimmer wave. */
const SHIMMER_HALF_WIDTH = 0.16;

function columnGlow(column: number, revealed: number, shimmer: number | undefined): number {
	if (revealed < ART_WIDTH) {
		const behind = revealed - 1 - column;
		if (behind >= 0 && behind < TYPE_TRAIL) {
			return Math.round((1 - behind / TYPE_TRAIL) * 10) / 10;
		}
		return 0;
	}
	if (shimmer === undefined || shimmer >= 1) return 0;
	const t = column / (ART_WIDTH - 1);
	// Sweep center from slightly off the left edge (-SHIMMER_HALF_WIDTH) to slightly past the right edge.
	const center = -SHIMMER_HALF_WIDTH + shimmer * (1 + 2 * SHIMMER_HALF_WIDTH);
	const dist = Math.abs(t - center);
	if (dist >= SHIMMER_HALF_WIDTH) return 0;
	const wave = Math.cos((dist / SHIMMER_HALF_WIDTH) * (Math.PI / 2));
	return Math.round(wave * wave * 10) / 10;
}

/** One art line, cut into runs that share a paint. */
function paintArt(paint: BannerPaint, line: string, revealed = line.length, shimmer?: number): string {
	let out = "";
	let run = "";
	let key = "";
	let style: ((text: string) => string) | undefined;
	const flush = () => {
		if (run) out += style ? style(run) : run;
		run = "";
	};
	for (let column = 0; column < line.length; column++) {
		const isCursor = paint.cursor !== undefined && revealed > 0 && revealed < line.length && column === revealed;
		// Columns the reveal has not reached stay blank (or show the typing cursor): height & width stay constant.
		const char = isCursor ? "▌" : column < revealed ? line[column] : " ";
		let nextKey = " ";
		let nextStyle: ((text: string) => string) | undefined;
		if (isCursor) {
			nextKey = "cursor";
			nextStyle = (text) => paint.cursor!(text);
		} else if (char !== " ") {
			if (paint.ramp) {
				const t = Math.round((column / (ART_WIDTH - 1)) * STEPS) / STEPS;
				const glow = columnGlow(column, revealed, shimmer);
				nextKey = glow > 0 ? `t:${t}:g:${glow}` : `t:${t}`;
				nextStyle = (text) => paint.ramp!(t, text, glow);
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

/**
 * The beta notice in the widest form that fits: its words go before the link loses a character, since a cut link opens
 * nothing. Narrower than the shortest form, the line is cut and ends in `…`.
 */
function noticeLine(paint: BannerPaint, width: number): string {
	const link = (url: string) => paint.fg("mdLink", url);
	const beta = paint.fg("warning", "BETA");
	const forms = [
		`${paint.fg("warning", "BETA version")} ${paint.fg("muted", "; please assign issues here")} ${link(ISSUES_URL)}`,
		`${beta}${paint.fg("muted", " · ")}${link(ISSUES_URL)}`,
		`${beta}${paint.fg("muted", " · ")}${link(ISSUES_URL.replace(/^https:\/\//, ""))}`,
	];
	const fits = forms.find((form) => visibleWidth(form) <= width);
	return fits ?? truncateToWidth(forms.at(-1)!, width, "…");
}

/** `status` (painted): one more line under the notice, such as the backlog counts (`backlog-status.ts`). */
export function bannerLines(
	paint: BannerPaint,
	width: number,
	status?: (paint: BannerPaint) => string | undefined,
	/** How much of the art shows, 0..1 (default all): a left-to-right typing reveal. The notice appears with the last column. */
	reveal = 1,
	/** Optional 0..1 post-typing shimmer sweep position across the settled art. */
	shimmer?: number,
): string[] {
	const revealed = Math.ceil(Math.min(1, Math.max(0, reveal)) * ART_WIDTH);
	const art =
		width >= ART_WIDTH
			? BANNER_ART.map((line) => paintArt(paint, line, revealed, shimmer))
			: [`${paint.fg("accent", "OCTOCODE")} ${paint.fg("mdLink", "AGENT")}`, ""];
	const fit = Math.max(1, width);
	const extra = status?.(paint);
	const settled = reveal >= 1;
	// Until the art is whole the notice and the status line are blank rows, so the height never changes. Every line fits
	// the width, however narrow the terminal; a cut text line ends in `…`.
	return [
		...art.map((line) => truncateToWidth(line, fit, "")),
		settled ? noticeLine(paint, fit) : "",
		...(extra ? [settled ? truncateToWidth(extra, fit, "…") : ""] : []),
	];
}
