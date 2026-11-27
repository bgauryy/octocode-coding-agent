/** @vitest-environment jsdom */
import type { ProfileEvent, ProfileMessage, ProfileRequest, ProfileTimeline } from "@octocodeai/octocode-contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flowLabel, flowPairs } from "../src/app/live/profiler/message-model.ts";
import { MessagesPanel } from "../src/app/live/profiler/MessagesPanel.tsx";
import type { PanelProps } from "../src/app/live/profiler/panel-props.ts";
import { filterTrace, isProblem } from "../src/app/live/profiler/trace-filter.ts";
import {
	buildLanes,
	cacheSegments,
	contextSeries,
	groupTools,
	hitItem,
	layoutLane,
	openActivityEvent,
	requestLookup,
} from "../src/app/live/profiler/trace-model.ts";
import { fitRange, minimapBuckets, resolveView, tailRange } from "../src/app/live/profiler/trace-view.ts";
import { TracePanel } from "../src/app/live/profiler/TracePanel.tsx";
import { agent as makeAgent, request as makeRequest } from "./profiler-fixtures.ts";

afterEach(cleanup);

const T0 = 1_000_000;
const viewport = { from: T0, to: T0 + 10_000, width: 1000 };
const bounds = { from: T0, to: T0 + 10_000 };

function ev(
	id: string,
	kind: ProfileEvent["kind"],
	at: number,
	durationMs?: number,
	extra: Partial<ProfileEvent> = {},
): ProfileEvent {
	return {
		id: `main:${kind}:${id}`,
		agentId: "main",
		kind,
		at: T0 + at,
		durationMs,
		label: extra.label ?? `${kind} ${id}`,
		...extra,
	};
}

describe("trace lanes and open activity", () => {
	it("puts requests and waits on the run track and tools on their own thin track", () => {
		const layout = layoutLane(
			[
				ev("r", "request", 0, 3000),
				ev("t", "tool", 500, 1000, { label: "bash" }),
				ev("t2", "tool", 700, 1000, { label: "rg" }),
			],
			viewport,
		);
		const byKind = (kind: string) => layout.items.filter((item) => item.event.kind === kind);
		expect(byKind("request")[0]).toMatchObject({ track: "run", row: 0 });
		expect(byKind("tool").map((item) => [item.track, item.row])).toEqual([
			["tool", 0],
			["tool", 1],
		]);
		expect([layout.runRows, layout.toolRows]).toEqual([1, 2]);
		expect(layout.geo.toolY).toBeGreaterThan(layout.geo.runY);
		expect(layout.geo.contextY).toBe(layout.geo.toolY + 2 * 12);
	});

	it("answers a click within 6 px of a 2 px request span", () => {
		const wide = { from: T0, to: T0 + 25_000, width: 900 };
		const layout = layoutLane([ev("r", "request", 0, 48, { ref: { request: 0 } })], wide);
		const y = layout.geo.runY + 4;
		expect(layout.items[0]?.width).toBe(2);
		expect(hitItem(layout, 3, y)?.event.kind).toBe("request");
		expect(hitItem(layout, -2, y)?.event.kind).toBe("request");
		expect(hitItem(layout, 6, y)).toBeUndefined();
	});

	it("reserves room for the context lane only when asked", () => {
		const plain = layoutLane([], viewport);
		const withContext = layoutLane([], viewport, undefined, { contextLane: true });
		expect(withContext.geo.height - plain.geo.height).toBe(34);
	});

	it("draws the running activity as a bar that grows with the clock and never as a stored event", () => {
		const working = {
			id: "main",
			status: "working" as const,
			activity: { kind: "request" as const, label: "opus", since: T0 + 2000 },
		};
		const at = (now: number) => layoutLane([], viewport, undefined, { open: openActivityEvent(working, now) }).items[0];
		const first = at(T0 + 3000);
		const later = at(T0 + 6000);
		expect(first).toMatchObject({ open: true, x: 200, track: "run" });
		expect(first?.width).toBe(100);
		expect(later?.width).toBe(400);
		expect(openActivityEvent({ ...working, status: "idle" }, T0 + 3000)).toBeUndefined();
		expect(openActivityEvent({ id: "main", status: "working" }, T0)).toBeUndefined();
		const tool = openActivityEvent(
			{ ...working, activity: { kind: "tool", label: "bash", since: T0, count: 3 } },
			T0 + 1000,
		);
		expect(tool).toMatchObject({ kind: "tool", label: "bash \u00D73", durationMs: 1000 });
	});

	it("drops the open bar once the real event with the same start has landed", () => {
		const working = {
			id: "main",
			status: "working" as const,
			activity: { kind: "tool" as const, label: "bash", since: T0 + 1000 },
		};
		const real = ev("t", "tool", 1000, 500, { label: "bash" });
		const layout = layoutLane([real], viewport, undefined, { open: openActivityEvent(working, T0 + 2000) });
		expect(layout.items).toHaveLength(1);
		expect(layout.items[0]?.open).toBeUndefined();
	});

	it("builds lanes carrying status, context and activity", () => {
		const lanes = buildLanes([makeAgent("main", { contextWindow: 200_000, contextTokens: 50_000, status: "working" })]);
		expect(lanes[0]).toMatchObject({ contextWindow: 200_000, contextTokens: 50_000, status: "working" });
	});
});

describe("cache split and break marker", () => {
	const request = makeRequest("main", 0, {
		usage: { input: 100, output: 10, cacheRead: 600, cacheWrite: 300 },
		firstBreak: 2,
	});
	it("splits a request bar into cached, written and uncached pixels in order", () => {
		const layout = layoutLane(
			[ev("r", "request", 0, 2000, { ref: { request: 0 } })],
			viewport,
			requestLookup(new Map([["main", [request]]])),
		);
		const item = layout.items[0];
		const segments = cacheSegments(item);
		expect(segments.map((s) => s.state)).toEqual(["cached", "written", "uncached"]);
		expect(segments.map((s) => Math.round(s.width))).toEqual([120, 60, 20]);
		expect(segments[1]?.x).toBeCloseTo(120);
		expect(item?.breakAt).toBeCloseTo(120);
	});

	it("leaves the break marker off when the prefix held and the bar plain without request data", () => {
		const held = { ...request, firstBreak: undefined };
		const layout = layoutLane(
			[ev("r", "request", 0, 2000, { ref: { request: 0 } })],
			viewport,
			requestLookup(new Map([["main", [held]]])),
		);
		expect(layout.items[0]?.breakAt).toBeUndefined();
		expect(cacheSegments(layoutLane([ev("r", "request", 0, 2000)], viewport).items[0])).toEqual([]);
	});
});

describe("grouping repeated tools", () => {
	const calls = [
		ev("a", "tool", 0, 500, { label: "bash" }),
		ev("b", "tool", 800, 500, { label: "bash", outcome: "error" }),
		ev("c", "tool", 1500, 500, { label: "rg" }),
		ev("d", "tool", 9000, 500, { label: "bash" }),
	];
	it("merges neighbouring calls of one tool, keeps others and far calls apart", () => {
		const entries = groupTools(calls);
		expect(entries.map((entry) => [entry.event.label, entry.group?.count])).toEqual([
			["bash \u00D72", 2],
			["rg", undefined],
			["bash", undefined],
		]);
		expect(entries[0]?.event).toMatchObject({ at: T0, durationMs: 1300, outcome: "error" });
		expect(entries[0]?.group?.ids).toEqual(["main:tool:a", "main:tool:b"]);
	});

	it("lays a group out as one bar only when grouping is on", () => {
		expect(layoutLane(calls, viewport).items).toHaveLength(4);
		const grouped = layoutLane(calls, viewport, undefined, { group: true });
		expect(grouped.items).toHaveLength(3);
		expect(grouped.items[0]?.group?.count).toBe(2);
	});
});

describe("zoom, brush, fit and the live tail", () => {
	it("follows the tail, fits a target with padding and lets a range win over fit", () => {
		expect(tailRange(bounds, bounds.to, 4000)).toEqual({ from: T0 + 6000, to: T0 + 10_000 });
		expect(tailRange(bounds, bounds.to, 99_000)).toEqual(bounds);
		expect(fitRange({ from: T0 + 4000, to: T0 + 5000 }, bounds)).toEqual({ from: T0 + 3900, to: T0 + 5100 });
		expect(fitRange({ from: T0, to: T0 + 100 }, bounds).from).toBe(T0);
		const range = { from: T0 + 2000, to: T0 + 3000 };
		expect(resolveView({ kind: "fit" }, undefined, bounds)).toEqual(bounds);
		expect(resolveView({ kind: "fit" }, range, bounds)).toEqual(range);
		expect(resolveView({ kind: "tail", spanMs: 2000 }, undefined, bounds)).toEqual({
			from: T0 + 8000,
			to: T0 + 10_000,
		});
		expect(resolveView({ kind: "fixed", from: T0 + 1, to: T0 + 2 }, range, bounds)).toEqual({
			from: T0 + 1,
			to: T0 + 2,
		});
	});

	it("sums busy lanes per minimap bucket and ignores idle gaps", () => {
		const buckets = minimapBuckets(
			[ev("a", "request", 0, 5000), ev("b", "tool", 0, 2500), ev("i", "idle", 0, 10_000)],
			bounds,
			4,
		);
		expect(buckets).toEqual([2, 1, 0, 0]);
	});
});

describe("context lane and filters", () => {
	it("plots tokens after each request against the window", () => {
		const requests: ProfileRequest[] = [
			makeRequest("main", 0, { at: T0 + 1000, usage: { input: 0, output: 1000, cacheRead: 49_000, cacheWrite: 0 } }),
			makeRequest("main", 1, { at: T0 + 5000, usage: { input: 0, output: 1000, cacheRead: 99_000, cacheWrite: 0 } }),
		];
		const points = contextSeries(requests, 200_000, viewport);
		expect(points.map((p) => [p.x, p.tokens, p.fraction])).toEqual([
			[100, 50_000, 0.25],
			[500, 100_000, 0.5],
		]);
		expect(contextSeries(requests, undefined, viewport)).toEqual([]);
	});

	it("filters problems and hidden kinds", () => {
		const events = [
			ev("r", "request", 0, 100),
			ev("t", "tool", 0, 100, { outcome: "error" }),
			ev("i", "interrupt", 5),
			ev("w", "wait", 0, 100),
		];
		const base = { text: "", problemsOnly: false, hidden: new Set<never>() };
		expect(filterTrace(events, { ...base, problemsOnly: true }).map((e) => e.kind)).toEqual(["tool", "interrupt"]);
		expect(filterTrace(events, { ...base, hidden: new Set(["tools", "waits"] as const) }).map((e) => e.kind)).toEqual([
			"request",
			"interrupt",
		]);
		const broke = makeRequest("main", 0, { firstBreak: 1 });
		expect(
			isProblem(ev("r", "request", 0, 1, { ref: { request: 0 } }), requestLookup(new Map([["main", [broke]]]))),
		).toBe(true);
		expect(hitItem(layoutLane([], viewport), 5, 5)).toBeUndefined();
	});
});

const agents = [
	makeAgent("main", {
		model: "claude-opus-4-5",
		contextWindow: 200_000,
		compactAt: 160_000,
		contextTokens: 150_000,
		status: "working",
		activity: { kind: "request", label: "opus", since: Date.now() - 4000 },
	}),
	makeAgent("alpha", { parentId: "main", model: "haiku", outcome: "done" }),
];
const events: ProfileEvent[] = [
	ev("r0", "request", 0, 2400, { ref: { request: 0 } }),
	ev("t0", "tool", 1000, 3000, { label: "bash" }),
	{ ...ev("n0", "interrupt", 5000), agentId: "alpha", id: "alpha:interrupt:n0", label: "user interrupt" },
];
const messages: ProfileMessage[] = [
	{
		id: 1,
		from: "main",
		to: ["alpha"],
		at: T0 + 2600,
		state: "answered",
		preview: "go",
		deliveredMs: 400,
		answeredMs: 3000,
	},
];
const timeline: ProfileTimeline = { sessionId: "s", events, messages, until: T0 + 6000, hasMore: false };

function props(
	overrides: Partial<PanelProps & { evidence: { agentId: string; request?: number }[] }> = {},
): PanelProps {
	return {
		agents,
		requests: new Map([
			[
				"main",
				[
					makeRequest("main", 0, {
						at: T0 + 2400,
						usage: { input: 1000, output: 10, cacheRead: 38_000, cacheWrite: 81_000 },
					}),
				],
			],
		]),
		timeline,
		selection: undefined,
		onSelect: vi.fn(),
		range: undefined,
		onRange: vi.fn(),
		filter: "",
		...overrides,
	};
}

describe("TracePanel", () => {
	it("renders lanes, a gutter with the context percentage, labelled bars, markers and arrows", () => {
		render(createElement(TracePanel, props()));
		expect(screen.getAllByRole("group", { name: /^Lane / })).toHaveLength(2);
		expect(screen.getByRole("button", { name: "request 0, 38k cached, 81k written, 1k uncached, 2.4s" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "interrupt user interrupt" })).toBeTruthy();
		expect(screen.getAllByRole("img", { name: /^message \d/ })).toHaveLength(1);
		const lane = screen.getByRole("button", { name: /^agent main, claude-opus-4-5/ });
		expect(lane.textContent).toContain("main \u00B7 claude-opus-4-5");
		expect(screen.getByTitle(/^Context 75% of the window/)).toBeTruthy();
		expect(screen.getByRole("img", { name: "Context of main per request" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^agent alpha.*ended done/ })).toBeTruthy();
	});

	it("draws the working agent's open bar and a now line, and offers Live", () => {
		render(createElement(TracePanel, props({ timeline: { ...timeline, events: events.slice(0, 1) } })));
		expect(screen.getByRole("button", { name: /^request, .*running/ })).toBeTruthy();
		expect(screen.getByText("now")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Live/ }).getAttribute("aria-pressed")).toBe("true");
	});

	it("selects through onSelect from the keyboard, the gutter and the markers", () => {
		const onSelect = vi.fn();
		render(createElement(TracePanel, props({ onSelect })));
		fireEvent.keyDown(screen.getByRole("button", { name: /^request 0/ }), { key: "Enter" });
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "request", agentId: "main", index: 0 });
		fireEvent.keyDown(screen.getByRole("button", { name: /^tool bash/ }), { key: " " });
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "event", id: "main:tool:t0" });
		fireEvent.click(screen.getByRole("button", { name: /^agent alpha/ }));
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "agent", agentId: "alpha" });
		fireEvent.click(screen.getByRole("button", { name: "interrupt user interrupt" }));
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "event", id: "alpha:interrupt:n0" });
	});

	it("marks the selected bar and rings evidence bars", () => {
		render(
			createElement(TracePanel, {
				...props({ selection: { kind: "request", agentId: "main", index: 0 } }),
				evidence: [{ agentId: "main", event: "main:tool:t0" }],
			}),
		);
		expect(screen.getByRole("button", { name: /^request 0/ }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: /^tool bash/ }).querySelector(".is-evidence")).toBeTruthy();
	});

	it("zooms with +, resets with Escape, steps with ] and groups with G", () => {
		const onRange = vi.fn();
		const onSelect = vi.fn();
		render(
			createElement(
				TracePanel,
				props({
					onRange,
					onSelect,
					timeline: { ...timeline, events: events.slice(0, 2), messages: [] },
					agents: [{ ...agents[0], status: "idle", activity: undefined }],
				}),
			),
		);
		const region = screen.getByRole("region", { name: "Trace" });
		const shown = () => region.querySelector("p")?.textContent ?? "";
		expect(shown()).toContain("4.0s shown");
		fireEvent.keyDown(region, { key: "+" });
		expect(shown()).toContain("2.4s shown");
		fireEvent.keyDown(region, { key: "]" });
		expect(onSelect).toHaveBeenLastCalledWith({ kind: "request", agentId: "main", index: 0 });
		fireEvent.keyDown(region, { key: "g" });
		expect(within(region).getByRole("button", { name: "Group tools" }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.keyDown(region, { key: "Escape" });
		expect(onRange).toHaveBeenCalledWith(undefined);
		expect(shown()).toContain("4.0s shown");
	});

	it("filters with chips and keeps a table for screen readers", () => {
		render(createElement(TracePanel, props()));
		expect(
			within(screen.getByRole("table", { name: "Visible trace events" })).getAllByRole("row").length,
		).toBeGreaterThan(3);
		fireEvent.click(screen.getByRole("button", { name: "Tools" }));
		expect(screen.queryByRole("button", { name: /^tool bash/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Problems only" }));
		expect(screen.queryByRole("button", { name: /^request 0/ })).toBeNull();
		expect(screen.getByRole("button", { name: "interrupt user interrupt" })).toBeTruthy();
	});

	it("collapses the context lane and pins a lane to the top", () => {
		render(createElement(TracePanel, props()));
		fireEvent.click(screen.getByRole("button", { name: "Hide context lane of main" }));
		expect(screen.queryByRole("img", { name: "Context of main per request" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Pin alpha to the top" }));
		expect(screen.getAllByRole("group", { name: /^Lane / })[0]?.getAttribute("aria-label")).toBe("Lane alpha");
	});

	it("says so when there is nothing to draw", () => {
		render(createElement(TracePanel, props({ timeline: { ...timeline, events: [], messages: [] } })));
		expect(screen.getByText("No events recorded yet.")).toBeTruthy();
	});
});

describe("Messages flow strip, pills and waiting time", () => {
	const msgs: ProfileMessage[] = [
		{
			id: 1,
			from: "main",
			to: ["tidal"],
			at: T0,
			state: "answered",
			preview: "a",
			deliveredMs: 80,
			answeredMs: 72_000,
		},
		{ id: 2, from: "main", to: ["tidal"], at: T0 + 10, state: "awaiting reply", preview: "b", deliveredMs: 20 },
		{ id: 3, from: "tidal", to: ["main"], at: T0 + 20, state: "dead-lettered", preview: "c" },
	];
	it("counts per sender and receiver, busiest first, with the awaiting tail", () => {
		const pairs = flowPairs(msgs);
		expect(pairs.map(flowLabel)).toEqual([
			"main \u2192 tidal 2 \u00B7 1 awaiting reply",
			"tidal \u2192 main 1 \u00B7 1 dead-lettered",
		]);
	});

	it("filters by pair, shows pills, latencies and a ticking wait", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(T0 + 61_000);
			const tl: ProfileTimeline = { sessionId: "s", events: [], messages: msgs, until: T0, hasMore: false };
			render(createElement(MessagesPanel, props({ timeline: tl })));
			const rows = () => screen.getAllByRole("row").slice(1);
			expect(rows()).toHaveLength(3);
			expect(rows()[0]?.textContent).toContain("delivered 80ms \u00B7 answered 1m 12s");
			expect(rows()[1]?.textContent).toMatch(/awaiting reply.*waiting 01:0\d/);
			const before = rows()[1]?.textContent;
			act(() => void vi.advanceTimersByTime(5000));
			expect(rows()[1]?.textContent).not.toBe(before);
			fireEvent.click(screen.getByRole("button", { name: /^tidal \u2192 main 1/ }));
			expect(rows()).toHaveLength(1);
			expect(rows()[0]?.textContent).toContain("dead-lettered");
		} finally {
			vi.useRealTimers();
		}
	});
});
