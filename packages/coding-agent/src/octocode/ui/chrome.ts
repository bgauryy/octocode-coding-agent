import fs from "node:fs";
import path from "node:path";
import { type Color, mixColors, SPINNER } from "@octocodeai/octocode-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import type { Theme } from "../../theme/theme.ts";
import { getPackageDir } from "../../config.ts";
import { stopRowTimers } from "../shared/render/rows.ts";
import { STATUS } from "../shared/status.ts";
import { type BannerPaint, bannerLines } from "./banner.ts";
import { registerFooter } from "./footer.ts";
import { registerAwaiting } from "./awaiting.ts";
import { registerTurnLine } from "./turn-line.ts";

let version: { value: string | undefined } | undefined;

export function packageVersion(): string | undefined {
	if (version) return version.value;
	try {
		const manifest = path.join(getPackageDir(), "package.json");
		version = { value: (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string }).version };
	} catch {
		version = { value: undefined };
	}
	return version.value;
}

/** Colour at `t` (0..1) along evenly spaced stops. */
function along(stops: Color[], t: number): Color {
	if (stops.length === 1) return stops[0];
	const scaled = Math.min(1, Math.max(0, t)) * (stops.length - 1);
	const index = Math.min(stops.length - 2, Math.floor(scaled));
	return mixColors(stops[index], stops[index + 1], scaled - index);
}

/**
 * The banner's gradient, from the theme: accent → borderAccent → mdLink → syntaxOperator (purple to teal in the
 * Octocode themes), in bold. Undefined when the theme has no concrete colours, so the banner uses tokens instead.
 */
export function themeRamp(theme: Theme): BannerPaint["ramp"] {
	let colors: Theme["colors"] | undefined;
	try {
		colors = theme.colors;
	} catch {
		return undefined;
	}
	if (!colors) return undefined;
	const stops = [colors.accent, colors.borderAccent, colors.mdLink, colors.syntaxOperator].filter(
		(color): color is Color => color !== undefined,
	);
	if (stops.length === 0 || typeof theme.style !== "function") return undefined;
	const cache = new Map<number, Color>();
	return (t, text) => {
		let color = cache.get(t);
		if (!color) {
			color = along(stops, t);
			cache.set(t, color);
		}
		return theme.style(text, { fg: color, bold: true });
	};
}

/** The working indicator: a braille spinner whose frames walk the banner's gradient. */
export function spinnerFrames(theme: Theme): string[] {
	const ramp = themeRamp(theme);
	return SPINNER.braille.map((frame, index) => {
		// Out and back, so the colour loops without a jump.
		const t = 1 - Math.abs(1 - (2 * index) / SPINNER.braille.length);
		return ramp ? ramp(t, frame) : theme.fg("accent", frame);
	});
}

/**
 * The banner as Octocode's header component. It is static: lines are computed once per width and kept until
 * `invalidate`, so the header never asks for a frame and never makes the renderer redraw the scrollback on its own.
 * `onInvalidate` runs when Octocode invalidates the header: a theme switch does, and Octocode has no theme event for
 * extensions.
 */
export function bannerHeader(theme: Theme, onInvalidate?: () => void) {
	// Read from the theme again on invalidate: Octocode invalidates components when the theme changes.
	const painted = (): BannerPaint => {
		const ramp = themeRamp(theme);
		return { fg: (color, text) => theme.fg(color as never, text), ...(ramp ? { ramp } : {}) };
	};
	let paint = painted();
	let cached: { width: number; lines: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (cached?.width !== width) cached = { width, lines: bannerLines(paint, width) };
			return cached.lines;
		},
		invalidate(): void {
			cached = undefined;
			paint = painted();
			onInvalidate?.();
		},
	};
}

/**
 * Octocode's look in the TUI: the static "OCTOCODE CODE" banner as the header (in place of the built-in key hints; it
 * is not in the session, so it stays put across /new, /resume and /fork), a two-line footer, a gradient working
 * spinner, and the generation speed of the last run. Only time spent streaming assistant
 * messages counts toward the speed, so tool calls, subagents and askUser waits don't drag the number down.
 */
export function registerUi(api: ExtensionAPI, isSubagent: boolean): void {
	if (isSubagent) return;
	registerFooter(api);
	registerTurnLine(api);
	registerAwaiting(api);
	let generated = { output: 0, ms: 0 };
	let messageStartedAt: number | undefined;
	api.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS.speed, undefined);
		if (ctx.mode === "tui") decorate(ctx);
	});
	api.on("agent_start", async () => {
		generated = { output: 0, ms: 0 };
		messageStartedAt = undefined;
	});
	api.on("message_start", async (event) => {
		if (event.message.role === "assistant") messageStartedAt = Date.now();
	});
	api.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || messageStartedAt === undefined) return;
		generated.ms += Date.now() - messageStartedAt;
		generated.output += event.message.usage.output;
		messageStartedAt = undefined;
	});
	api.on("agent_end", async (_event, ctx) => {
		// Every call of the run ended. Octocode drops rows it never gave a result here; their clocks must not tick on.
		stopRowTimers();
		if (!ctx.hasUI) return;
		const speed = tokensPerSecond(generated.output, generated.ms);
		// A run too short to measure clears the previous run's figure rather than leaving it beside this run's time.
		ctx.ui.setStatus(STATUS.speed, speed === undefined ? undefined : `${speed.toFixed(0)} tok/s`, "dim");
	});
}

function decorate(ctx: ExtensionContext): void {
	// The spinner is a painted string: repaint it whenever a theme switch invalidates the header.
	ctx.ui.setHeader((_tui, current) => bannerHeader(current, () => paintIndicators(ctx)));
	paintIndicators(ctx);
}

/** A running tool row animates its own spinner: the working line then keeps its first frame, so two never spin at once. */
let rowsAnimate = false;

function paintIndicators(ctx: ExtensionContext): void {
	const frames = spinnerFrames(ctx.ui.theme);
	// Octocode's loader steps every 80 ms when no interval is given; one frame is a still mark with no shimmer.
	ctx.ui.setWorkingIndicator({ frames: rowsAnimate ? frames.slice(0, 1) : frames });
}

/** Hold (`true`) or restore the working line's own spinner; a no-op when it is already so. */
export function setRowsAnimate(ctx: ExtensionContext, animate: boolean): void {
	if (rowsAnimate === animate) return;
	rowsAnimate = animate;
	paintIndicators(ctx);
}

/** Streaming shorter than this is mostly one network chunk: a reply of a few tokens would read as thousands per second. */
const MIN_SPEED_SAMPLE_MS = 1_000;

/** Output tokens per second of streaming time, or undefined when nothing was generated or too briefly to measure. */
export function tokensPerSecond(outputTokens: number, streamingMs: number): number | undefined {
	return streamingMs >= MIN_SPEED_SAMPLE_MS && outputTokens > 0 ? outputTokens / (streamingMs / 1000) : undefined;
}
