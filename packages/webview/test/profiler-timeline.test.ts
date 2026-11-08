/** @vitest-environment jsdom */
import type {
	ProfileAgent,
	ProfileEvent,
	ProfileMessage,
	ProfileRequest,
	ProfileTimeline,
} from "@octocodeai/octocode-contracts";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesPanel } from "../src/app/live/profiler/MessagesPanel.tsx";
import type { PanelProps } from "../src/app/live/profiler/panel-props.ts";
import { hitArrow, layoutArrows } from "../src/app/live/profiler/trace-arrows.ts";
import { filterEvents } from "../src/app/live/profiler/trace-filter.ts";
import { formatLatency } from "../src/app/live/profiler/trace-format.ts";
import { buildLanes, cacheSplit, hitItem, layoutLane, requestLookup } from "../src/app/live/profiler/trace-model.ts";
import { brushRange, panBy, sessionBounds, timeToX, xToTime, zoomAround } from "../src/app/live/profiler/trace-view.ts";
import { filterMessages, groupThreads } from "../src/app/live/profiler/message-model.ts";

afterEach(cleanup);

const T0 = 1_000_000;
const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input, output: 10, cacheRead, cacheWrite });

function agent(id: string, parentId?: string, model = "claude-x"): ProfileAgent {
	return {
		id,
		parentId,
		role: parentId ? "implementer" : "main",
		model,
		status: "idle",
		requests: 1,
		totals: usage(0, 0, 0),
		profiled: true,
	};
}

function event(
	id: string,
	agentId: string,
	kind: ProfileEvent["kind"],
	at: number,
	durationMs?: number,
	extra: Partial<ProfileEvent> = {},
): ProfileEvent {
	return {
		id: `${agentId}:${kind}:${id}`,
		agentId,
		kind,
		at: T0 + at,
		durationMs,
		label: extra.label ?? `${kind} ${id}`,
		...extra,
	};
}

const agents = [agent("main"), agent("alpha", "main"), agent("beta", "alpha")];
const events: ProfileEvent[] = [
	event("r0", "main", "request", 0, 2400, { ref: { request: 42 }, tokens: 120_000 }),
	event("t0", "main", "tool", 1000, 3000, { label: "bash" }),
	event("s0", "main", "spawn", 2500, undefined, { peer: "alpha" }),
	event("i0", "main", "idle", 4000, 2000),
	event("r1", "alpha", "request", 3000, 1500, { ref: { request: 0 } }),
	event("w0", "alpha", "wait", 4500, 1000, { label: "permission" }),
	event("n0", "beta", "interrupt", 5000, undefined, { label: "user interrupt" }),
];
const messages: ProfileMessage[] = [
	{
		id: 1,
		from: "main",
		to: ["alpha"],
		at: T0 + 2600,
		state: "answered",
		preview: "review the diff",
		deliveredMs: 400,
		answeredMs: 3000,
	},
	{
		id: 2,
		from: "alpha",
		to: ["main"],
		at: T0 + 5600,
		replyTo: 1,
		state: "delivered",
		preview: "looks fine",
		text: "looks fine\n\nOne nit: rename the helper before merging.",
		deliveredMs: 100,
	},
	{ id: 3, from: "main", to: ["beta"], at: T0 + 5000, state: "dead-lettered", preview: "are you there" },
];
const request42: ProfileRequest = {
	agentId: "main",
	index: 42,
	at: T0 + 2400,
	model: "claude-x",
	usage: usage(1000, 38_000, 81_000),
	layers: [],
	estimated: false,
};
const timeline: ProfileTimeline = { sessionId: "s", events, messages, until: T0 + 6000, hasMore: false };
const viewport = { from: T0, to: T0 + 6000, width: 600 };

describe("timeline layout", () => {
	it("lists lanes in tree order with depth", () => {
		expect(buildLanes(agents).map((lane) => [lane.agentId, lane.depth])).toEqual([
			["main", 0],
			["alpha", 1],
			["beta", 2],
		]);
	});

	it("maps time to pixels and back", () => {
		expect(timeToX(T0 + 3000, viewport)).toBe(300);
		expect(xToTime(150, viewport)).toBe(T0 + 1500);
	});

	it("stacks overlapping spans into rows, keeps instants and idle apart, culls outside the viewport", () => {
		const layout = layoutLane(
			events.filter((e) => e.agentId === "main"),
			viewport,
		);
		const row = (kind: string) => layout.items.find((item) => item.event.kind === kind);
		expect(row("request")).toMatchObject({ x: 0, width: 240, row: 0, span: true });
		expect(row("tool")).toMatchObject({ x: 100, width: 300, track: "tool", row: 0 });
		expect(row("spawn")).toMatchObject({ x: 250, width: 0, span: false });
		expect(row("idle")).toMatchObject({ background: true, row: 0 });
		expect([layout.runRows, layout.toolRows]).toEqual([1, 1]);
		const zoomed = layoutLane(events, { from: T0 + 5000, to: T0 + 6000, width: 100 });
		expect(zoomed.items.map((item) => item.event.id)).toEqual(["main:idle:i0", "alpha:wait:w0", "beta:interrupt:n0"]);
	});

	it("splits a loaded request into cache fractions", () => {
		const lookup = requestLookup(new Map([["main", [request42]]]));
		const layout = layoutLane(events.slice(0, 1), viewport, lookup);
		const cache = layout.items[0]?.cache;
		expect(cache?.cached).toBeCloseTo(38 / 120);
		expect(cache?.written).toBeCloseTo(81 / 120);
		expect(cache?.uncached).toBeCloseTo(1 / 120);
		expect(layoutLane(events.slice(0, 1), viewport).items[0]?.cache).toBeUndefined();
		expect(cacheSplit({ ...request42, usage: usage(0, 0, 0) })).toMatchObject({ cached: 0, tooShort: false });
	});

	it("places arrows from the sender at send time to the receiver at delivery time", () => {
		const lanes = buildLanes(agents);
		const arrows = layoutArrows(messages, lanes, viewport);
		expect(arrows[0]).toMatchObject({ fromLane: 0, toLane: 1, x1: 260, x2: 300 });
		expect(arrows[1]).toMatchObject({ fromLane: 1, toLane: 0, x1: 560, x2: 570 });
		// Delivery unknown: the arrow ends where it started.
		expect(arrows[2]).toMatchObject({ fromLane: 0, toLane: 2, x1: 500, x2: 500 });
		expect(hitArrow(arrows, 280, 27, (lane) => lane * 50 + 2)?.message.id).toBe(1);
		expect(hitArrow(arrows, 20, 400, (lane) => lane * 50)).toBeUndefined();
	});

	it("hit-tests instants on the marker strip and spans by row", () => {
		const layout = layoutLane(
			events.filter((e) => e.agentId === "main"),
			viewport,
		);
		const { markerY, runY, toolY } = layout.geo;
		expect(hitItem(layout, 252, markerY + 2)?.event.kind).toBe("spawn");
		expect(hitItem(layout, 120, runY + 4)?.event.kind).toBe("request");
		expect(hitItem(layout, 120, toolY + 3)?.event.kind).toBe("tool");
		expect(hitItem(layout, 450, runY + 4)).toBeUndefined();
	});
});

describe("range, zoom and filters", () => {
	const bounds = { from: T0, to: T0 + 6000 };

	it("derives the session bounds including deliveries", () => {
		expect(sessionBounds(events, messages)).toEqual(bounds);
		expect(sessionBounds([], [])).toBeUndefined();
	});

	it("zooms around the cursor and clamps to the session", () => {
		const zoomed = zoomAround(bounds, 0.5, T0 + 1500, bounds);
		expect(zoomed).toEqual({ from: T0 + 750, to: T0 + 3750 });
		expect(zoomAround(zoomed, 10, T0 + 1500, bounds)).toEqual(bounds);
		expect(zoomAround(bounds, 0.0001, T0, bounds).to - T0).toBe(50);
		expect(panBy(zoomed, -5000, bounds)).toEqual({ from: T0, to: T0 + 3000 });
		expect(panBy(zoomed, 9000, bounds)).toEqual({ from: T0 + 3000, to: T0 + 6000 });
	});

	it("brushes in either direction and ignores a click", () => {
		expect(brushRange(T0 + 3000, T0 + 1000, bounds)).toEqual({ from: T0 + 1000, to: T0 + 3000 });
		expect(brushRange(T0 + 1000, T0 + 1010, bounds)).toBeUndefined();
	});

	it("filters events and messages by range and text", () => {
		const inRange = filterEvents(events, { from: T0 + 4600, to: T0 + 4700 }, "");
		expect(inRange.map((e) => e.kind)).toEqual(["idle", "wait"]);
		expect(filterEvents(events, undefined, "permission").map((e) => e.kind)).toEqual(["wait"]);
		expect(
			filterMessages(messages, { filter: "", range: { from: T0 + 5500, to: T0 + 6000 } }).map((m) => m.id),
		).toEqual([2]);
		expect(filterMessages(messages, { filter: "dead", range: undefined }).map((m) => m.id)).toEqual([3]);
		expect(filterMessages(messages, { filter: "", range: undefined, agentId: "beta" }).map((m) => m.id)).toEqual([3]);
	});
});

describe("message threads", () => {
	it("indents replies under their message and keeps orphans as roots", () => {
		expect(groupThreads(messages).map((row) => [row.message.id, row.depth])).toEqual([
			[1, 0],
			[2, 1],
			[3, 0],
		]);
		expect(groupThreads(messages.slice(1)).map((row) => [row.message.id, row.depth])).toEqual([
			[3, 0],
			[2, 0],
		]);
	});

	it("formats latency", () => {
		expect([undefined, 850, 2400, 65_000].map(formatLatency)).toEqual(["\u2014", "850ms", "2.4s", "1m 5s"]);
	});
});

function props(overrides: Partial<PanelProps> = {}): PanelProps {
	return {
		agents,
		requests: new Map([["main", [request42]]]),
		timeline,
		selection: undefined,
		onSelect: vi.fn(),
		range: undefined,
		onRange: vi.fn(),
		filter: "",
		...overrides,
	};
}

describe("MessagesPanel", () => {
	it("lists messages as a thread table with state text and latencies", () => {
		render(createElement(MessagesPanel, props()));
		const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(3);
		expect(rows[0]?.textContent).toContain("main \u2192 alpha");
		expect(rows[0]?.textContent).toContain("answered");
		expect(rows[0]?.textContent).toContain("3.0s");
		expect(rows[1]?.getAttribute("aria-level")).toBe("2");
		expect(rows[2]?.textContent).toContain("dead-lettered");
		expect(rows[2]?.textContent).toContain("\u2014");
	});

	it("shows the whole text of the selected message only, and filters on it", () => {
		const { rerender } = render(createElement(MessagesPanel, props()));
		expect(screen.queryByText(/One nit/)).toBeNull();
		rerender(createElement(MessagesPanel, props({ selection: { kind: "message", id: 2 } })));
		expect(screen.getByLabelText("Full text of message 2").textContent).toContain("One nit: rename the helper");
		rerender(createElement(MessagesPanel, props({ filter: "rename the helper" })));
		expect(screen.getAllByRole("row")).toHaveLength(2);
	});

	it("shows each message's absolute send time beside its offset", () => {
		render(createElement(MessagesPanel, props()));
		const time = screen.getAllByRole("row")[1]?.querySelector("time");
		expect(time?.getAttribute("dateTime")).toBe(new Date(T0 + 2600).toISOString());
		expect(time?.getAttribute("title")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it("filters by text, range and selected agent", () => {
		const { rerender } = render(createElement(MessagesPanel, props({ filter: "fine" })));
		expect(screen.getAllByRole("row")).toHaveLength(2);
		rerender(createElement(MessagesPanel, props({ range: { from: T0 + 4900, to: T0 + 5100 } })));
		expect(screen.getAllByRole("row")).toHaveLength(2);
		rerender(createElement(MessagesPanel, props({ selection: { kind: "agent", agentId: "beta" } })));
		expect(screen.getByText("are you there")).toBeTruthy();
		expect(screen.queryByText("review the diff")).toBeNull();
		rerender(createElement(MessagesPanel, props({ filter: "zzz" })));
		expect(screen.getByText(/No messages match/)).toBeTruthy();
	});

	it("selects a message by click and keyboard and marks the selected row", () => {
		const onSelect = vi.fn();
		render(createElement(MessagesPanel, props({ onSelect, selection: { kind: "message", id: 2 } })));
		const rows = screen.getAllByRole("row").slice(1);
		expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
		fireEvent.click(rows[0]);
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "message", id: 1 });
		fireEvent.keyDown(rows[2], { key: "Enter" });
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "message", id: 3 });
	});
});
