import type { ProfileActivity, ProfileAgent, ProfileEvent, ProfileRequest } from "@octocodeai/octocode-contracts";
import { timeToX, type Viewport } from "./trace-view.ts";

/** Pure layout and hit-testing for the Trace waterfall (axis maths: `trace-view.ts`, filters: `trace-filter.ts`). */

export interface Lane {
	agentId: string;
	role: string;
	model?: string;
	depth: number;
	status: ProfileAgent["status"];
	outcome?: string;
	contextWindow?: number;
	compactAt?: number;
	contextTokens?: number;
	activity?: ProfileActivity;
}

/** One lane per agent in the given (tree) order; depth counts parents that are listed. */
export function buildLanes(agents: readonly ProfileAgent[]): Lane[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	return agents.map((agent) => {
		let depth = 0;
		const seen = new Set([agent.id]);
		let parent = agent.parentId ? byId.get(agent.parentId) : undefined;
		while (parent && !seen.has(parent.id)) {
			seen.add(parent.id);
			depth += 1;
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
		return {
			agentId: agent.id,
			role: agent.role,
			model: agent.model,
			depth,
			status: agent.status,
			outcome: agent.outcome,
			contextWindow: agent.contextWindow,
			compactAt: agent.compactAt,
			contextTokens: agent.contextTokens,
			activity: agent.activity,
		};
	});
}

export type CacheSplit = { cached: number; written: number; uncached: number; tooShort: boolean };

/** Fractions (0 to 1, summing to 1 when there are prompt tokens) of a request's prompt by cache state. */
export function cacheSplit(request: ProfileRequest): CacheSplit {
	const { input, cacheRead, cacheWrite } = request.usage;
	const total = input + cacheRead + cacheWrite;
	const tooShort =
		total > 0 && request.layers.length > 0 && request.layers.every((layer) => layer.state === "too-short");
	if (total <= 0) return { cached: 0, written: 0, uncached: 0, tooShort: false };
	return { cached: cacheRead / total, written: cacheWrite / total, uncached: input / total, tooShort };
}

export type RequestLookup = (agentId: string, index: number) => ProfileRequest | undefined;

/** Looks a request up by its index among the loaded pages of an agent. */
export function requestLookup(requests: ReadonlyMap<string, readonly ProfileRequest[]>): RequestLookup {
	return (agentId, index) => requests.get(agentId)?.find((request) => request.index === index);
}

type Track = "run" | "tool";

export interface LaneItem {
	event: ProfileEvent;
	x: number;
	/** Pixels wide; 0 for an instant. */
	width: number;
	/** Stacking row within the track; instants and idle gaps use 0. */
	row: number;
	/** Requests, waits and idle sit on the run track, tool calls on the thin tool track beneath. */
	track: Track;
	/** True for a span (has a duration), false for an instant marker. */
	span: boolean;
	/** Idle gaps are drawn behind the other spans of the lane, across every row. */
	background: boolean;
	/** An activity still running: it ends at `now` and grows with it. */
	open?: boolean;
	/** Set when several repeated calls were merged into this bar. */
	group?: { count: number; ids: string[] };
	cache?: CacheSplit;
	request?: ProfileRequest;
	/** Pixel offset from `x` of the cache break marker: where the cached prefix ended. */
	breakAt?: number;
}

export const MARKER_H = 14;
export const RUN_BAR_H = 18;
export const RUN_ROW_H = 20;
export const TOOL_BAR_H = 10;
export const TOOL_ROW_H = 12;
export const CONTEXT_H = 34;
const LANE_PAD = 4;

interface LaneGeometry {
	markerY: number;
	runY: number;
	toolY: number;
	contextY: number;
	height: number;
}

export interface LaneLayout {
	items: LaneItem[];
	runRows: number;
	toolRows: number;
	geo: LaneGeometry;
}

function geometry(runRows: number, toolRows: number, contextLane: boolean): LaneGeometry {
	const markerY = LANE_PAD;
	const runY = markerY + MARKER_H;
	const toolY = runY + runRows * RUN_ROW_H;
	const contextY = toolY + toolRows * TOOL_ROW_H;
	return { markerY, runY, toolY, contextY, height: contextY + (contextLane ? CONTEXT_H : 0) + LANE_PAD };
}

const MIN_SPAN_PX = 2;
/** The narrowest width a span answers a click over. */
const MIN_HIT_PX = 6;
/** Repeated calls closer than this are one bar when grouping is on. */
const GROUP_GAP_MS = 2000;

function isSpan(event: ProfileEvent): boolean {
	return (event.durationMs ?? 0) > 0;
}

interface Entry {
	event: ProfileEvent;
	group?: { count: number; ids: string[] };
}

/** Merges consecutive calls of the same tool that start within `gapMs` of the previous one's end. */
export function groupTools(events: readonly ProfileEvent[], gapMs = GROUP_GAP_MS): Entry[] {
	const open = new Map<string, ProfileEvent[]>();
	const finished: ProfileEvent[][] = [];
	const others: ProfileEvent[] = [];
	for (const event of events) {
		if (event.kind !== "tool") {
			others.push(event);
			continue;
		}
		const run = open.get(event.label);
		const last = run?.at(-1);
		if (run && last && event.at - (last.at + (last.durationMs ?? 0)) <= gapMs) run.push(event);
		else {
			if (run) finished.push(run);
			open.set(event.label, [event]);
		}
	}
	finished.push(...open.values());
	const entries: Entry[] = others.map((event) => ({ event }));
	for (const run of finished) {
		const first = run[0];
		if (!first) continue;
		if (run.length === 1) {
			entries.push({ event: first });
			continue;
		}
		const end = Math.max(...run.map((event) => event.at + (event.durationMs ?? 0)));
		const outcome = run.some((event) => event.outcome === "error")
			? "error"
			: run.some((event) => event.outcome === "aborted")
				? "aborted"
				: first.outcome;
		entries.push({
			event: {
				...first,
				id: `${first.id}+${run.length - 1}`,
				durationMs: end - first.at,
				label: `${first.label} \u00D7${run.length}`,
				outcome,
				tokens: run.reduce((sum, event) => sum + (event.tokens ?? 0), 0) || undefined,
			},
			group: { count: run.length, ids: run.map((event) => event.id) },
		});
	}
	return entries.sort((a, b) => a.event.at - b.event.at);
}

const OPEN_KIND = { request: "request", tool: "tool", wait: "wait", compaction: "compaction" } as const;

/**
 * What a working agent is doing now as a growing event, from `agent.activity`; undefined when it is not working. It is
 * drawn, never stored: the real event replaces it (with its own id) when the activity ends.
 */
export function openActivityEvent(
	agent: Pick<ProfileAgent, "id" | "status" | "activity">,
	now: number,
): ProfileEvent | undefined {
	const { activity } = agent;
	if (agent.status !== "working" || !activity) return undefined;
	const count = activity.count && activity.count > 1 ? ` \u00D7${activity.count}` : "";
	return {
		id: `${agent.id}:open:${activity.kind}`,
		agentId: agent.id,
		kind: OPEN_KIND[activity.kind],
		at: activity.since,
		durationMs: Math.max(0, now - activity.since),
		label: `${activity.label}${count}`,
		peer: activity.peer,
	};
}

export interface LayoutOptions {
	minSpanPx?: number;
	/** Merge repeated calls of one tool into one bar. */
	group?: boolean;
	/** The running activity, from `openActivityEvent`. */
	open?: ProfileEvent;
	/** Reserve room for the context lane under the bars. */
	contextLane?: boolean;
}

/**
 * Lays one lane's events (oldest first) on the time scale. Only events inside the viewport are returned. Spans stack
 * into the first row of their track whose last span ended before they start, so overlaps never hide each other.
 */
export function layoutLane(
	events: readonly ProfileEvent[],
	viewport: Viewport,
	lookup?: RequestLookup,
	options: LayoutOptions = {},
): LaneLayout {
	const minSpanPx = options.minSpanPx ?? MIN_SPAN_PX;
	const entries: Entry[] = options.group ? groupTools(events) : events.map((event) => ({ event }));
	const open = options.open;
	const landed = open && events.some((event) => event.kind === open.kind && event.at === open.at);
	if (open && !landed) entries.push({ event: open });
	const items: LaneItem[] = [];
	const rowEnds: Record<Track, number[]> = { run: [], tool: [] };
	for (const { event, group } of entries) {
		const isOpen = event === open && !landed;
		const span = isSpan(event) || isOpen;
		const end = event.at + (event.durationMs ?? 0);
		if (end < viewport.from || event.at > viewport.to) continue;
		const x = timeToX(event.at, viewport);
		const track: Track = event.kind === "tool" ? "tool" : "run";
		if (!span) {
			items.push({ event, x, width: 0, row: 0, track, span: false, background: false });
			continue;
		}
		const width = Math.max(minSpanPx, timeToX(end, viewport) - x);
		const background = event.kind === "idle";
		let row = 0;
		if (!background) {
			const ends = rowEnds[track];
			while (row < ends.length && (ends[row] ?? -Infinity) > x) row += 1;
			ends[row] = x + width + 1;
		}
		const index = event.kind === "request" ? event.ref?.request : undefined;
		const request = index === undefined ? undefined : lookup?.(event.agentId, index);
		const cache = request ? cacheSplit(request) : undefined;
		items.push({
			event,
			x,
			width,
			row,
			track,
			span: true,
			background,
			open: isOpen || undefined,
			group,
			cache,
			request,
			breakAt: request?.firstBreak !== undefined && cache ? cache.cached * width : undefined,
		});
	}
	const runRows = Math.max(1, rowEnds.run.length);
	const toolRows = rowEnds.tool.length;
	return { items, runRows, toolRows, geo: geometry(runRows, toolRows, options.contextLane === true) };
}

export interface CacheSegment {
	state: "cached" | "written" | "uncached";
	x: number;
	width: number;
}

/** A request bar split left to right into cached, written and uncached pixels; zero shares are left out. */
export function cacheSegments(item: Pick<LaneItem, "x" | "width" | "cache">): CacheSegment[] {
	const { cache } = item;
	if (!cache) return [];
	const parts = [
		["cached", cache.cached],
		["written", cache.written],
		["uncached", cache.uncached],
	] as const;
	const segments: CacheSegment[] = [];
	let x = item.x;
	for (const [state, fraction] of parts) {
		const width = fraction * item.width;
		if (width > 0) segments.push({ state, x, width });
		x += width;
	}
	return segments;
}

/** Events grouped by agent, keeping their order. */
export function eventsByAgent(events: readonly ProfileEvent[]): Map<string, ProfileEvent[]> {
	const grouped = new Map<string, ProfileEvent[]>();
	for (const event of events) {
		const list = grouped.get(event.agentId);
		if (list) list.push(event);
		else grouped.set(event.agentId, [event]);
	}
	return grouped;
}

export interface ContextPoint {
	x: number;
	tokens: number;
	/** Tokens over the window, capped a little above 1. */
	fraction: number;
}

/** Context tokens after each request (prompt plus output) against the window: one point per request near the viewport. */
export function contextSeries(
	requests: readonly ProfileRequest[] | undefined,
	contextWindow: number | undefined,
	viewport: Viewport,
): ContextPoint[] {
	if (!requests?.length || !contextWindow) return [];
	const points = requests.map((request) => {
		const { input, cacheRead, cacheWrite, output } = request.usage;
		const tokens = input + cacheRead + cacheWrite + output;
		return {
			at: request.at,
			x: timeToX(request.at, viewport),
			tokens,
			fraction: Math.min(1.05, tokens / contextWindow),
		};
	});
	const first = Math.max(0, points.findIndex((point) => point.at >= viewport.from) - 1);
	const after = points.findIndex((point) => point.at > viewport.to);
	return points
		.slice(first, after < 0 ? undefined : after + 1)
		.map(({ x, tokens, fraction }) => ({ x, tokens, fraction }));
}

/** The item under `x` in a lane layout; `y` counts from the lane top. Instants answer within `slop` px on the marker strip. */
export function hitItem(layout: LaneLayout, x: number, y: number, slop = 4): LaneItem | undefined {
	const { geo } = layout;
	if (y >= geo.markerY && y < geo.runY) {
		let best: LaneItem | undefined;
		let bestDistance = Infinity;
		for (const item of layout.items) {
			if (item.span) continue;
			const distance = Math.abs(item.x - x);
			if (distance <= slop && distance < bestDistance) {
				best = item;
				bestDistance = distance;
			}
		}
		return best;
	}
	const track: Track | undefined =
		y >= geo.runY && y < geo.toolY ? "run" : y >= geo.toolY && y < geo.contextY ? "tool" : undefined;
	if (!track) return undefined;
	const row = track === "run" ? Math.floor((y - geo.runY) / RUN_ROW_H) : Math.floor((y - geo.toolY) / TOOL_ROW_H);
	// A span thinner than MIN_HIT_PX is grabbed over MIN_HIT_PX, centred on it: a 48 ms request on a 25 s axis is 2 px.
	for (let index = layout.items.length - 1; index >= 0; index -= 1) {
		const item = layout.items[index];
		if (!item?.span || item.background || item.track !== track || item.row !== row) continue;
		const pad = Math.max(0, MIN_HIT_PX - item.width) / 2;
		if (x >= item.x - pad && x <= item.x + item.width + pad) return item;
	}
	return undefined;
}
