import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentEvents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { AgentLifecycleBus, type LifecycleEvent } from "../../src/octocode/team/lifecycle-bus.ts";
import { STALLED_LISTED_MS } from "../../src/octocode/team/store/limits.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { TeamTicker } from "../../src/octocode/team/ticker.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

let root: string;
let db: AgentDb;
/** The first Octocode process, and a second one on its own connection to the same file. */
let mine: TeamStore;
let peer: TeamStore;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	status: "working",
	joinedAt: 1000,
	updatedAt: 1000,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const busOver = (store: TeamStore) => {
	const sync = vi.fn();
	const since = vi.fn((after: number) => store.presence.since(after));
	const bus = new AgentLifecycleBus({ head: store.presence.head, since, sync });
	store.presence.onWrite((from, to) => bus.wrote(from, to));
	return { bus, since, sync };
};

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-bus-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
	mine = TeamStore.open(root, db.file);
	mine.lifecycle = { activationId: "mine", sessionId: "session-mine" };
	peer = TeamStore.open(root, db.file);
	peer.lifecycle = { activationId: "peer", sessionId: "session-peer" };
});
afterEach(() => {
	peer.close();
	mine.close();
	db.close();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the lifecycle bus", () => {
	it("emits a join and an end once each, with the reason and stats, from either process's write", () => {
		const { bus } = busOver(mine);
		const heard: LifecycleEvent[] = [];
		bus.on((event) => heard.push(event));
		const a = member("amber-otter", { toolCalls: 3, cost: 0.5 });
		const b = member("brisk-lynx", { parentId: "amber-otter" });
		mine.join(a);
		peer.join(b);
		peer.remove("brisk-lynx", 2000, b, "completed");
		mine.remove("amber-otter", 3000, a);
		bus.poll();
		bus.poll();
		expect(heard.map((event) => [event.kind, event.agent, event.own])).toEqual([
			["on", "amber-otter", true],
			["on", "brisk-lynx", false],
			["off", "brisk-lynx", false],
			["off", "amber-otter", true],
		]);
		expect(heard[2]).toMatchObject({ parent: "amber-otter", reason: "completed", sessionId: "session-peer" });
		expect(heard[3]).toMatchObject({ reason: "left", stats: { status: "working", pid: process.pid } });
		expect(heard.map((event) => event.seq)).toEqual(heard.map((event) => event.seq).sort((x, y) => x - y));
	});

	it("reports a reaped agent as crashed, written by the reaping process", () => {
		const { bus } = busOver(mine);
		const heard: LifecycleEvent[] = [];
		bus.on((event) => heard.push(event));
		peer.join(member("dead-one", { pid: 2 ** 22 + 4321 }));
		mine.sweep(Date.now());
		bus.poll();
		expect(heard.map((event) => [event.kind, event.reason, event.own])).toEqual([
			["on", undefined, false],
			["off", "crashed", true],
		]);
	});

	it("starts at the newest event: what happened before the first listener is not replayed", () => {
		peer.join(member("before-one"));
		const { bus } = busOver(mine);
		const heard: string[] = [];
		bus.on((event) => heard.push(event.agent));
		peer.join(member("after-one"));
		bus.poll();
		expect(heard).toEqual(["after-one"]);
	});

	it("keeps the other listeners hearing when one throws, and follows the database only while listened to", () => {
		const { bus, sync } = busOver(mine);
		expect(bus.listening).toBe(false);
		const heard: string[] = [];
		const off = bus.on(() => {
			throw new Error("listener failed");
		});
		bus.on((event) => heard.push(event.agent));
		expect(bus.listening).toBe(true);
		peer.join(member("loud-one"));
		bus.poll();
		expect(heard).toEqual(["loud-one"]);
		off();
		expect(sync).toHaveBeenCalledTimes(3);
	});

	it("the ticker reads events only when the database file changed", () => {
		vi.useFakeTimers();
		const { bus, since } = busOver(mine);
		const heard: string[] = [];
		bus.on((event) => heard.push(`${event.kind}:${event.agent}`));
		const ticker = new TeamTicker({
			joined: () => false,
			beat: () => undefined,
			dbFile: () => db.file,
			read: () => ({ members: [], traffic: [] }),
			resumed: () => undefined,
			following: () => bus.listening,
			changed: () => bus.poll(),
			maxAgeMs: 1000,
		});
		// The ticker follows the file through the process's shared follower, one clock tick per look.
		const tick = () => vi.advanceTimersByTime(1000);
		ticker.sync();
		tick();
		const quiet = since.mock.calls.length;
		tick();
		tick();
		expect(since.mock.calls.length).toBe(quiet);
		peer.join(member("moved-one"));
		tick();
		expect(heard).toEqual(["on:moved-one"]);
		const after = since.mock.calls.length;
		tick();
		expect(since.mock.calls.length).toBe(after);
		ticker.reset();
		bus.on(() => undefined)();
	});
});

describe("stalled episodes", () => {
	const stalledEvents = () =>
		agentEvents.since(db.db, 0).filter((event) => event.type === "update" && event.data.state === "stalled");
	const prune = (store: TeamStore, at: number) => (store as unknown as { prune(at: number): void }).prune(at);
	// The stores prune at most once a minute from their opening: the test's clock starts a minute after it.
	const start = () => Date.now() + 61_000;

	it("writes one stalled update per silence, whichever process notices, and a new one after a heartbeat", () => {
		const t0 = start();
		const quiet = member("quiet-one", {
			updatedAt: t0 - STALLED_LISTED_MS - 5000,
			model: "test-model",
			activity: "bash: yarn test",
		});
		mine.join(quiet);
		prune(mine, t0);
		prune(peer, t0 + 1000);
		prune(mine, t0 + 120_000);
		expect(stalledEvents()).toHaveLength(1);
		expect(stalledEvents()[0]).toMatchObject({ name: "quiet-one", data: { state: "stalled", agentId: "quiet-one" } });
		// The episode says what the profiler groups by: the cause, the last activity, the model and the silence in minutes.
		expect(stalledEvents()[0]?.data).toMatchObject({
			detail: "silent",
			model: "test-model",
			activity: "bash: yarn test",
			minutes: Math.floor((STALLED_LISTED_MS + 5000) / 60_000),
		});
		// It beats again, then goes silent again: a second episode.
		mine.save({ ...quiet, updatedAt: t0 + 130_000 });
		prune(mine, t0 + 130_000 + STALLED_LISTED_MS + 61_000);
		expect(stalledEvents()).toHaveLength(2);
	});

	it("does not mark a member silent for less than the listing threshold", () => {
		const t0 = start();
		mine.join(member("short-one", { updatedAt: t0 - 120_000 }));
		prune(mine, t0);
		expect(stalledEvents()).toEqual([]);
	});
});
