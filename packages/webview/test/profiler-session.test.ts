import { expect, it } from "vitest";
import { resolveRoute, parseHash } from "../src/app/model/route.ts";
import type { ProfileEvent, ProfileFinding } from "@octocodeai/octocode-contracts";
import {
	emptySession,
	mergeTimeline,
	reduceSession,
	visibleEvents,
	visibleFindings,
} from "../src/app/live/profiler/session-state.ts";
import { agent, request } from "./profiler-fixtures.ts";

const event = (id: string, at: number, patch: Partial<ProfileEvent> = {}): ProfileEvent => ({
	id,
	agentId: "main",
	kind: "tool",
	at,
	label: "bash",
	...patch,
});
const start = reduceSession(emptySession, {
	type: "agents",
	value: { sessionId: "s", agents: [agent("main")], generatedAt: 0 },
});

it("merges timeline pages by id in time order and keeps the latest until", () => {
	let timeline = mergeTimeline(undefined, [event("b", 20), event("a", 10)], []);
	timeline = mergeTimeline(timeline, [event("a", 10, { label: "again" }), event("c", 30, { durationMs: 50 })], []);
	expect(timeline.events.map((item) => item.id)).toEqual(["a", "b", "c"]);
	expect(timeline.events[0].label).toBe("again");
	expect(timeline.until).toBe(80);
});

it("selecting an event selects its agent and request; live frames merge events and messages", () => {
	let session = reduceSession(start, {
		type: "timeline",
		value: {
			sessionId: "s",
			events: [event("main:request:1", 5, { kind: "request", ref: { request: 1 } })],
			messages: [],
			until: 5,
			hasMore: false,
		},
	});
	session = reduceSession(session, { type: "select", value: { kind: "event", id: "main:request:1" } });
	expect(session.core.agentId).toBe("main");
	expect(session.core.requestIndex).toBe(1);
	session = reduceSession(session, {
		type: "update",
		value: {
			agent: agent("main"),
			events: [event("main:tool:9", 9)],
			messages: [{ id: 3, from: "main", to: ["kid"], at: 9, state: "queued", preview: "hi" }],
		},
	});
	expect(session.timeline?.events).toHaveLength(2);
	expect(session.timeline?.messages.map((message) => message.id)).toEqual([3]);
});

it("holds frames while paused and applies them in order on resume", () => {
	let session = reduceSession(start, { type: "pause", value: true });
	session = reduceSession(session, {
		type: "update",
		value: { agent: agent("main", { requests: 1 }), request: request("main", 0) },
	});
	expect(session.held).toHaveLength(1);
	expect(session.core.agents[0].requests).toBe(0);
	session = reduceSession(session, { type: "pause", value: false });
	expect(session.held).toEqual([]);
	expect(session.core.agents[0].requests).toBe(1);
});

it("closes the drawer with an undefined selection and steps agents in tree order", () => {
	let session = reduceSession(emptySession, {
		type: "agents",
		value: {
			sessionId: "s",
			generatedAt: 1,
			agents: [agent("kid", { parentId: "main" }), agent("main")],
		},
	});
	session = reduceSession(session, { type: "select", value: { kind: "agent", agentId: "main" } });
	session = reduceSession(session, { type: "step", by: 1 });
	expect(session.selection).toEqual({ kind: "agent", agentId: "kid" });
	session = reduceSession(session, { type: "step", by: 5 });
	expect(session.selection).toEqual({ kind: "agent", agentId: "kid" });
	session = reduceSession(session, { type: "select", value: undefined });
	expect(session.selection).toBeUndefined();
});

it("narrows events by range and filter, and orders findings by cost", () => {
	let session = reduceSession(start, {
		type: "timeline",
		value: {
			sessionId: "s",
			events: [event("a", 10), event("b", 20, { label: "grep" })],
			messages: [],
			until: 20,
			hasMore: false,
		},
	});
	session = reduceSession(session, { type: "filter", value: "grep" });
	expect(visibleEvents(session).map((item) => item.id)).toEqual(["b"]);
	const finding = (id: string, patch: Partial<ProfileFinding>): ProfileFinding => ({
		id,
		kind: "cost",
		severity: "low",
		title: id,
		detail: "",
		evidence: [],
		...patch,
	});
	session = reduceSession(
		{ ...session, filter: "" },
		{ type: "insights", value: [finding("cheap", { cost: 0.1 }), finding("big", { cost: 2 })] },
	);
	expect(visibleFindings(session).map((item) => item.id)).toEqual(["big", "cheap"]);
});

it("sends the old agents link to the Profiler's Agents panel when that view exists", () => {
	expect(resolveRoute(parseHash("#agents"), ["board", "profiler"])).toEqual({
		kind: "view",
		view: "profiler",
		params: { panel: "overview" },
		moved: true,
	});
	for (const [old, panel] of [
		["agents", "overview"],
		["events", "overview"],
		["requests", "trace"],
		["timeline", "trace"],
	])
		expect(resolveRoute(parseHash(`#profiler?panel=${old}&agent=x`), ["profiler"])).toEqual({
			kind: "view",
			view: "profiler",
			params: { panel, agent: "x" },
			moved: true,
		});
	expect(resolveRoute(parseHash("#profiler?panel=trace"), ["profiler"])).toEqual({
		kind: "view",
		view: "profiler",
		params: { panel: "trace" },
	});
	expect(resolveRoute(parseHash("#agents"), ["board"])).toEqual({ kind: "view", view: "board", params: {} });
});
