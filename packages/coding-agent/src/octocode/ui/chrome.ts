import { registerToolDisplays } from "./tool-display.ts";
import fs from "node:fs";
import path from "node:path";
import { animationClock, type Color, mixColors, rgbColor, SPINNER } from "@octocodeai/octocode-tui";
import type { FeatureSetup, FeatureContext, SessionStartEvent } from "../../core/features/index.ts";
import type { Theme } from "../../theme/theme.ts";
import { getPackageDir } from "../../config.ts";
import { stopRowTimers } from "../render/rows.ts";
import { STATUS } from "../shared/status.ts";
import { type BannerPaint, bannerLines } from "./banner.ts";
import { registerFooter } from "./footer.ts";
import { registerAwaiting } from "./awaiting.ts";
import { registerWebNotices } from "./web-notices.ts";
import { backlogOpenItems, registerPhaseFeed } from "./phase-feed.ts";
import { registerPhaseLine } from "./phase-line.ts";
import { registerTurnLine } from "./turn-line.ts";
import { registerWakeRow } from "./wake-row.ts";
import { registerBacklogLine } from "./backlog-line.ts";
import { backlogStatusLine, startupBacklogCounts } from "./backlog-status.ts";
import type { BacklogCounts } from "../backlog/counts.ts";

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

/** Purple gradient accents blended with the active theme's accent so the banner stays lush purple yet reacts to theme switches. */
const PURPLE_MID: Color = rgbColor(139, 92, 246);
const PURPLE_BRIGHT: Color = rgbColor(168, 85, 247);
const PURPLE_ORCHID: Color = rgbColor(216, 180, 254);
/** Luminous lavender-white highlight mixed into the purple gradient at the typing edge and shimmer crest. */
const PURPLE_GLOW: Color = rgbColor(250, 245, 255);
/** Bright orchid-white colour for the typing cursor glyph (`▌`). */
const PURPLE_CURSOR: Color = rgbColor(245, 208, 254);

/**
 * The banner's purple gradient anchored on the active theme's `accent` colour (in bold), with optional `glow` (0..1)
 * highlighting for the typing frontier and shimmer wave. Undefined when the theme has no concrete colours.
 */
export function themeRamp(theme: Theme): BannerPaint["ramp"] {
	let colors: Theme["colors"] | undefined;
	try {
		colors = theme.colors;
	} catch {
		return undefined;
	}
	if (!colors || typeof theme.style !== "function") return undefined;
	const base = colors.accent ?? colors.borderAccent ?? colors.mdLink;
	if (!base) return undefined;
	const mid = colors.borderAccent ?? base;
	const stops: Color[] = [
		base,
		mixColors(base, PURPLE_MID, 0.55),
		mixColors(mid, PURPLE_BRIGHT, 0.65),
		mixColors(base, PURPLE_ORCHID, 0.72),
	];
	const cache = new Map<string, Color>();
	return (t, text, glow = 0) => {
		const key = glow > 0 ? `${t}:${glow}` : `${t}`;
		let color = cache.get(key);
		if (!color) {
			const c = along(stops, t);
			color = glow > 0 ? mixColors(c, PURPLE_GLOW, glow * 0.78) : c;
			cache.set(key, color);
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
 * features.
 */
export interface BannerReveal {
	/** Asks for a repaint of the header. */
	requestRender(): void;
	/** Wipe duration (default `BANNER_REVEAL_MS`). */
	durationMs?: number;
}

/** One-time startup animation duration: typing reveal (first 72%) + luminous purple shimmer sweep (last 28%). */
const BANNER_REVEAL_MS = 900;
/** Fraction of the animation spent typing columns in; the remainder sweeps a purple shimmer across the settled art. */
const TYPE_PHASE_RATIO = 0.72;
/** Smooth ~30 fps frame cadence for the startup typing and shimmer animation. */
const BANNER_FRAME_MS = 32;

export function bannerHeader(theme: Theme, onInvalidate?: () => void, backlog?: BacklogCounts, reveal?: BannerReveal) {
	const status = backlog ? (paint: BannerPaint) => backlogStatusLine(paint, backlog) : undefined;
	// Read from the theme again on invalidate: Octocode invalidates components when the theme changes.
	const painted = (): BannerPaint => {
		const ramp = themeRamp(theme);
		const cursor = ramp ? (glyph: string) => theme.style(glyph, { fg: PURPLE_CURSOR, bold: true }) : undefined;
		return { fg: (color, text) => theme.fg(color as never, text), ...(ramp ? { ramp, cursor } : {}) };
	};
	let paint = painted();
	let cached: { width: number; lines: string[] } | undefined;
	// The typing + shimmer animation repaints at ~30 fps until it settles, then the header is static again.
	const startedAt = Date.now();
	const durationMs = reveal ? (reveal.durationMs ?? BANNER_REVEAL_MS) : 0;
	let unsubscribe: (() => void) | undefined;
	const progress = () => (durationMs > 0 ? Math.min(1, (Date.now() - startedAt) / durationMs) : 1);
	if (reveal && durationMs > 0) {
		unsubscribe = animationClock.subscribe(
			() => {
				if (progress() >= 1) {
					unsubscribe?.();
					unsubscribe = undefined;
					cached = undefined;
				}
				reveal.requestRender();
			},
			{ everyMs: BANNER_FRAME_MS, kind: "decor" },
		);
	}
	return {
		render(width: number): string[] {
			const p = progress();
			if (p < 1) {
				if (p < TYPE_PHASE_RATIO) {
					return bannerLines(paint, width, status, p / TYPE_PHASE_RATIO);
				}
				const shimmer = (p - TYPE_PHASE_RATIO) / (1 - TYPE_PHASE_RATIO);
				return bannerLines(paint, width, status, 1, shimmer);
			}
			if (cached?.width !== width) cached = { width, lines: bannerLines(paint, width, status) };
			return cached.lines;
		},
		dispose(): void {
			unsubscribe?.();
			unsubscribe = undefined;
		},
		invalidate(): void {
			cached = undefined;
			paint = painted();
			onInvalidate?.();
		},
	};
}

/**
 * Octocode's look in the TUI: the static "OCTOCODE AGENT" banner as the header (in place of the built-in key hints; it
 * is not in the session, so it stays put across /new, /resume and /fork), a two-line footer, a gradient working
 * spinner, and the generation speed of the last run. Only time spent streaming assistant
 * messages counts toward the speed, so tool calls, subagents and askUser waits don't drag the number down.
 */
export function registerUi(api: FeatureSetup, isSubagent: boolean): void {
	registerToolDisplays(api);
	if (isSubagent) return;
	registerFooter(api);
	registerPhaseFeed(api, backlogOpenItems);
	registerTurnLine(api);
	registerPhaseLine(api);
	registerWakeRow(api);
	registerBacklogLine(api);
	registerAwaiting(api);
	registerWebNotices(api);
	let generated = { output: 0, ms: 0 };
	let messageStartedAt: number | undefined;
	api.bus.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS.speed, undefined);
		if (ctx.mode === "tui") decorate(ctx, event.reason);
	});
	api.bus.on("agent_start", async () => {
		generated = { output: 0, ms: 0 };
		messageStartedAt = undefined;
	});
	api.bus.on("message_start", async (event) => {
		if (event.message.role === "assistant") messageStartedAt = Date.now();
	});
	api.bus.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || messageStartedAt === undefined) return;
		generated.ms += Date.now() - messageStartedAt;
		generated.output += event.message.usage.output;
		messageStartedAt = undefined;
	});
	api.bus.on("agent_end", async (_event, ctx) => {
		// Every call of the run ended. Octocode drops rows it never gave a result here; their clocks must not tick on.
		stopRowTimers();
		if (!ctx.hasUI) return;
		const speed = tokensPerSecond(generated.output, generated.ms);
		// A run too short to measure clears the previous run's figure rather than leaving it beside this run's time.
		ctx.ui.setStatus(STATUS.speed, speed === undefined ? undefined : `${speed.toFixed(0)} tok/s`, "dim");
	});
}

/** Whether the banner has wiped in this process: it does so once, at the first fresh start. */
let revealed = false;

/**
 * Whether the banner wipes in now: once per process, at a fresh start on a terminal (the animation clock is still off a
 * terminal, in CI and in reduced motion), never when the session already holds messages (resume, continue, fork).
 */
function revealAtStart(ctx: FeatureContext, reason: SessionStartEvent["reason"]): boolean {
	if (revealed || reason !== "startup" || animationClock.isReducedMotion()) return false;
	if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return false;
	revealed = true;
	return true;
}

function decorate(ctx: FeatureContext, reason: SessionStartEvent["reason"]): void {
	// The spinner is a painted string: repaint it whenever a theme switch invalidates the header. The backlog counts are
	// read once per session start; the footer keeps them live.
	const backlog = startupBacklogCounts(ctx);
	const wipe = revealAtStart(ctx, reason);
	ctx.ui.setHeader((tui, current) =>
		bannerHeader(
			current,
			() => paintIndicators(ctx),
			backlog,
			wipe ? { requestRender: () => tui.requestRender() } : undefined,
		),
	);
	paintIndicators(ctx);
}

function paintIndicators(ctx: FeatureContext): void {
	// Octocode's loader steps every 80 ms when no interval is given; tool rows draw a still-shaped light mark, so the
	// working line always keeps its spinner.
	ctx.ui.setWorkingIndicator({ frames: spinnerFrames(ctx.ui.theme) });
}

/** Streaming shorter than this is mostly one network chunk: a reply of a few tokens would read as thousands per second. */
const MIN_SPEED_SAMPLE_MS = 1_000;

/** Output tokens per second of streaming time, or undefined when nothing was generated or too briefly to measure. */
export function tokensPerSecond(outputTokens: number, streamingMs: number): number | undefined {
	return streamingMs >= MIN_SPEED_SAMPLE_MS && outputTokens > 0 ? outputTokens / (streamingMs / 1000) : undefined;
}
