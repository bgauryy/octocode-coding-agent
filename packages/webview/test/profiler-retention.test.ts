import { expect, it } from "vitest";
import type { ProfileEvent, ProfileUpdate } from "@octocodeai/octocode-contracts";
import { emptySession, reduceSession, type ProfilerSession } from "../src/app/live/profiler/session-state.ts";
import { agent, request } from "./profiler-fixtures.ts";

const AGENTS = ["main", "a", "b", "c"];
const FRAMES = 8000;

/** One long pause: every frame re-sends the agent row; every 10th adds a request; a running tool's event repeats under one id for 5 frames. */
function frames(): ProfileUpdate[] {
	const next: Record<string, number> = {};
	return Array.from({ length: FRAMES }, (_, i) => {
		const id = AGENTS[i % AGENTS.length];
		const update: ProfileUpdate = {
			agent: agent(id, { requests: Math.floor(i / 10), parentId: id === "main" ? undefined : "main" }),
		};
		if (i % 10 < AGENTS.length) update.request = request(id, (next[id] = (next[id] ?? -1) + 1));
		const event: ProfileEvent = {
			id: `${id}:tool:${Math.floor(i / 20)}`,
			agentId: id,
			kind: "tool",
			at: i,
			label: `bash ${i}`,
		};
		update.events = [event];
		return update;
	});
}

const open = () => {
	let session = reduceSession(emptySession, {
		type: "agents",
		value: { sessionId: "s", agents: AGENTS.map((id) => agent(id)), generatedAt: 0 },
	});
	session = reduceSession(session, {
		type: "timeline",
		value: { sessionId: "s", events: [], messages: [], until: 0, hasMore: false },
	});
	for (const id of AGENTS)
		session = reduceSession(session, { type: "requests", value: { agentId: id, requests: [], hasMore: false } });
	return session;
};

/** Retained payload objects in the pause queue, whatever its shape. */
function retained(session: ProfilerSession) {
	const held = session.held as unknown as {
		events?: unknown[] | Map<unknown, unknown>;
		request?: unknown;
		requests?: unknown[] | Map<unknown, unknown>;
	}[];
	const count = (value: unknown[] | Map<unknown, unknown> | undefined) =>
		Array.isArray(value) ? value.length : (value?.size ?? 0);
	return {
		entries: held.length,
		events: held.reduce((sum, item) => sum + count(item.events), 0),
		requests: held.reduce((sum, item) => sum + (item.request ? 1 : count(item.requests)), 0),
	};
}

it("bounds a long pause to what is unique, and resume equals never pausing", { timeout: 60_000 }, () => {
	const all = frames();
	let paused = reduceSession(open(), { type: "pause", value: true });
	for (const frame of all) paused = reduceSession(paused, { type: "update", value: frame });
	const size = retained(paused);
	const resumed = reduceSession(paused, { type: "pause", value: false });

	let live = open();
	for (const frame of all) live = reduceSession(live, { type: "update", value: frame });

	// Duplicated agent rows and re-sent events are coalesced: one entry per agent, one event per id.
	expect(size.entries).toBeLessThanOrEqual(AGENTS.length);
	expect(size.events).toBe(new Set(all.map((frame) => frame.events?.[0].id)).size);
	// Nothing unique is dropped: the resumed state is the unpaused state.
	expect(resumed.core).toEqual(live.core);
	expect(resumed.timeline).toEqual(live.timeline);
	expect(resumed.paused).toBe(false);
	expect(resumed.held).toEqual([]);
});

it("counts every frame received while paused and keeps timeline events on resume", () => {
	const base = reduceSession(open(), { type: "pause", value: true });
	let session = base;
	for (const frame of frames().slice(0, 7)) session = reduceSession(session, { type: "update", value: frame });
	expect(session.heldFrames).toBe(7);
	expect(reduceSession(session, { type: "pause", value: false }).heldFrames).toBe(0);
});

it("resumes a request that skips past the loaded ones as a live frame would: dropped, with more raised", () => {
	const frames = [0, 1, 5].map((index): ProfileUpdate => ({ agent: agent("main"), request: request("main", index) }));
	let paused = reduceSession(open(), { type: "pause", value: true });
	let live = open();
	for (const value of frames) {
		paused = reduceSession(paused, { type: "update", value });
		live = reduceSession(live, { type: "update", value });
	}
	const resumed = reduceSession(paused, { type: "pause", value: false });
	expect(resumed.core).toEqual(live.core);
	expect(resumed.core.more.main).toBe(true);
	expect(resumed.core.requests.main.map((item) => item.index)).toEqual([0, 1]);
});

it("keeps every page of a long timeline: the view holds every page the host serves", () => {
	const PAGES = 200;
	const PER_PAGE = 500;
	let session = open();
	for (let page = 0; page < PAGES; page++) {
		const events = Array.from({ length: PER_PAGE }, (_, i): ProfileEvent => {
			const at = page * PER_PAGE + i;
			return { id: `main:tool:${at}`, agentId: "main", kind: "tool", at, label: "bash" };
		});
		session = reduceSession(session, {
			type: "timeline",
			value: { sessionId: "s", events, messages: [], until: (page + 1) * PER_PAGE, hasMore: page < PAGES - 1 },
		});
	}
	expect(session.timeline?.events).toHaveLength(PAGES * PER_PAGE);
});
