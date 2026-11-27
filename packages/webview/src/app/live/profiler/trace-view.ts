import type { ProfileEvent, ProfileMessage } from "@octocodeai/octocode-contracts";
import type { ProfileRange } from "./panel-props.ts";

/** Pure time-axis maths for the Trace: scale, bounds, zoom, pan, brush, fit and ruler ticks. */

export interface Viewport {
	from: number;
	to: number;
	/** Pixels the time range maps onto. */
	width: number;
}

export function timeToX(time: number, viewport: Viewport): number {
	const span = viewport.to - viewport.from;
	return span > 0 ? ((time - viewport.from) / span) * viewport.width : 0;
}

export function xToTime(x: number, viewport: Viewport): number {
	const width = viewport.width > 0 ? viewport.width : 1;
	return viewport.from + (x / width) * (viewport.to - viewport.from);
}

/**
 * The span of the whole session: first start to last end (events, deliveries). `liveUntil` extends the end to now while
 * an agent is still working, so open bars have room to grow. Never empty.
 */
export function sessionBounds(
	events: readonly ProfileEvent[],
	messages: readonly ProfileMessage[],
	liveUntil?: number,
): ProfileRange | undefined {
	let from = Infinity;
	let to = -Infinity;
	for (const event of events) {
		from = Math.min(from, event.at);
		to = Math.max(to, event.at + (event.durationMs ?? 0));
	}
	for (const message of messages) {
		from = Math.min(from, message.at);
		to = Math.max(to, message.at + (message.deliveredMs ?? 0));
	}
	if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
	if (liveUntil !== undefined) to = Math.max(to, liveUntil);
	return to > from ? { from, to } : { from, to: from + 1000 };
}

const MIN_ZOOM_SPAN_MS = 50;

function clampRange(from: number, span: number, bounds: ProfileRange): ProfileRange {
	const max = bounds.to - bounds.from;
	const size = Math.min(span, max);
	const start = Math.min(Math.max(from, bounds.from), bounds.to - size);
	return { from: start, to: start + size };
}

/** Scales the visible span by `factor` (below 1 zooms in) keeping `time` under the same screen position. */
export function zoomAround(view: ProfileRange, factor: number, time: number, bounds: ProfileRange): ProfileRange {
	const span = view.to - view.from;
	const next = Math.min(Math.max(span * factor, MIN_ZOOM_SPAN_MS), bounds.to - bounds.from);
	const ratio = span > 0 ? (time - view.from) / span : 0.5;
	return clampRange(time - ratio * next, next, bounds);
}

/** Moves the view by `delta` ms without leaving the bounds. */
export function panBy(view: ProfileRange, delta: number, bounds: ProfileRange): ProfileRange {
	return clampRange(view.from + delta, view.to - view.from, bounds);
}

/** A brush from two times in any order, clamped to the bounds; undefined when it is too small to mean a range. */
export function brushRange(a: number, b: number, bounds: ProfileRange): ProfileRange | undefined {
	const from = Math.max(bounds.from, Math.min(a, b));
	const to = Math.min(bounds.to, Math.max(a, b));
	return to - from >= MIN_ZOOM_SPAN_MS ? { from, to } : undefined;
}

/** The last `spanMs` before `end`, never starting before the bounds: the window a live view follows. */
export function tailRange(bounds: ProfileRange, end: number, spanMs: number): ProfileRange {
	const to = Math.max(end, bounds.from + MIN_ZOOM_SPAN_MS);
	return { from: Math.max(bounds.from, to - spanMs), to };
}

/** `target` widened by `pad` of its own span on each side (at least the minimum zoom), clamped to the bounds. */
export function fitRange(target: ProfileRange, bounds: ProfileRange, pad = 0.1): ProfileRange {
	const span = Math.max(target.to - target.from, MIN_ZOOM_SPAN_MS);
	const margin = span * pad;
	return clampRange(target.from - margin, span + margin * 2, bounds);
}

export function overlapsRange(start: number, end: number, range: ProfileRange | undefined): boolean {
	return !range || (end >= range.from && start <= range.to);
}

/** Ruler ticks at a 1, 2 or 5 step so about `target` marks fit the range. */
export function rulerTicks(range: ProfileRange, target = 8): number[] {
	const span = range.to - range.from;
	if (!(span > 0)) return [];
	const raw = span / Math.max(1, target);
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
	const ticks: number[] = [];
	for (let tick = Math.ceil(range.from / step) * step; tick <= range.to; tick += step) ticks.push(tick);
	return ticks;
}

export type ViewMode = { kind: "fit" } | { kind: "tail"; spanMs: number } | { kind: "fixed"; from: number; to: number };

/** The time window to draw: a brushed range wins, then a pinned window, a live tail, else the whole session. */
export function resolveView(mode: ViewMode, range: ProfileRange | undefined, bounds: ProfileRange): ProfileRange {
	if (mode.kind === "fixed") return { from: mode.from, to: mode.to };
	if (range) return { from: Math.max(bounds.from, range.from), to: Math.min(bounds.to, range.to) };
	if (mode.kind === "tail") return tailRange(bounds, bounds.to, mode.spanMs);
	return bounds;
}

/** Busy time per bucket across all events (how many lanes were working), for the minimap's silhouette. */
export function minimapBuckets(events: readonly ProfileEvent[], bounds: ProfileRange, count: number): number[] {
	const buckets = Array.from({ length: Math.max(1, count) }, () => 0);
	const size = (bounds.to - bounds.from) / buckets.length;
	if (!(size > 0)) return buckets;
	for (const event of events) {
		if (event.kind === "idle" || !event.durationMs) continue;
		const start = Math.max(event.at, bounds.from);
		const end = Math.min(event.at + event.durationMs, bounds.to);
		for (let at = Math.floor((start - bounds.from) / size); at < buckets.length; at += 1) {
			const lo = bounds.from + at * size;
			if (lo >= end) break;
			const overlap = Math.min(end, lo + size) - Math.max(start, lo);
			if (overlap > 0) buckets[at] = (buckets[at] ?? 0) + overlap / size;
		}
	}
	return buckets;
}
