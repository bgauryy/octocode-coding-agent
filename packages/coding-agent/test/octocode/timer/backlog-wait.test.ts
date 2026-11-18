import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, backlog as queries, openDatabase, sessions, timers } from "../../../../db/src/api.ts";
import { peerEnd } from "../../../src/octocode/timer/peer-end.ts";
import { backlogDeps } from "../../../src/octocode/timer/backlog-deps.ts";
import { conditionChecker, conditionWatcher } from "../../../src/octocode/timer/condition.ts";
import {
	armUntil,
	decodeCondition,
	encodeCondition,
	parseUntil,
	storedKind,
} from "../../../src/octocode/timer/conditions/index.ts";
import type { BacklogDeps, ConditionDeps } from "../../../src/octocode/timer/conditions/types.ts";
import { timerFields, rowCondition } from "../../../src/octocode/timer/model.ts";
import { untilOfEvent } from "../../../src/octocode/timer/on.ts";
import { TimerScheduler } from "../../../src/octocode/timer/scheduler.ts";
import type { BacklogChange } from "../../../src/octocode/shared/backlog-change.ts";
import { backlogFixtureFor } from "./backlog-wait-fixture.ts";
import { tmp } from "../helpers.ts";

const WS = "ws-wait";
const ME = "me-session";
const PEER = { id: "peer-agent" };
let root: string;
let agent: AgentDb;
const started: TimerScheduler[] = [];
let board: ReturnType<typeof backlogFixtureFor>;

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	board = backlogFixtureFor(agent, WS);
});
afterEach(() => {
	for (const each of started.splice(0)) each.stop();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

const add = (title: string, extra: Record<string, unknown> = {}) =>
	board.add({ title, goal: "checkable", why: "needed", createdBy: "user", ...extra });

/** A host over the real audit log; `feed` is the change feed, absent for a host that runs none. */
function host(own: Partial<ConditionDeps> = {}, feed?: BacklogDeps["subscribe"]) {
	const backlog = backlogDeps({
		db: () => agent,
		workspace: () => WS,
		own: (by) => by === ME,
		...(feed ? { subscribe: feed } : {}),
	});
	const deps: ConditionDeps = {
		backlog,
		reservation: () => undefined,
		context: () => undefined,
		item: (ref) => backlog.detail(ref)?.state,
		blockers: () => [],
		agentEnd: () => undefined,
		watchDatabase: () => () => undefined,
		judge: async () => ({ verdict: "skipped", reason: "none" }),
		...own,
	};
	return { deps, backlog, check: conditionChecker(deps), watch: conditionWatcher(deps) };
}

/** The condition a `wait on` call stores: armed with the audit cursor of this moment. */
const armed = (h: ReturnType<typeof host>, event: string, filter: object) =>
	parseUntil(armUntil(untilOfEvent(event, filter, undefined), () => h.backlog.head()))!;
const run = (cwd = root) => ({ cwd, row: { id: 1, checks: 0, spentUsd: 0, sessionId: ME } });

describe("item.changed", () => {
	it("needs something to watch and names only the change kinds there are", () => {
		expect(() => untilOfEvent("item.changed", {}, undefined)).toThrow(/needs one of filter\.ref/);
		expect(() => untilOfEvent("item.changed", { change: "note" }, undefined)).toThrow(/needs one of filter\.ref/);
		expect(() => untilOfEvent("item.changed", { ref: "B1", state: "done" }, undefined)).toThrow(/not state/);
		expect(() => parseUntil({ changed: { ref: "B1", change: "landed" } })).toThrow(/one or more of created, claimed/);
		expect(untilOfEvent("item.changed", { ref: "B1,B2", change: "done,note" }, undefined)).toEqual({
			changed: { ref: "B1,B2", change: "done,note" },
		});
	});

	it("hears a peer's note on the item, not what happened before the wait or what this session wrote", async () => {
		add("Peer work");
		board.update("B1", { state: "ongoing" }, PEER);
		board.update("B1", { note: "before the wait" }, PEER);
		const h = host();
		const condition = armed(h, "item.changed", { ref: "B1" });
		expect((await h.check(condition, run())).met).toBe(false);
		board.update("B1", { note: "my own note" }, { id: ME });
		expect((await h.check(condition, run())).met).toBe(false);
		board.update("B1", { note: "files are free" }, PEER);
		const heard = await h.check(condition, run());
		expect(heard.met).toBe(true);
		expect(heard.output).toContain("B1 note by peer-agent: files are free");
	});

	it("narrows by change kind, by epic and by path", async () => {
		add("Epic", { type: "epic" }); // B1
		add("Child", { parentId: "B1", paths: ["src/a/"] }); // B2
		add("Elsewhere", { paths: ["docs/"] }); // B3
		const h = host();
		const kind = armed(h, "item.changed", { ref: "B2,B3", change: "done" });
		const epic = armed(h, "item.changed", { epic: "B1" });
		const paths = armed(h, "item.changed", { path: "src/a/x.ts" });
		board.update("B3", { note: "noise" }, PEER);
		expect((await h.check(kind, run())).met).toBe(false);
		expect((await h.check(epic, run())).met).toBe(false);
		expect((await h.check(paths, run())).met).toBe(false);
		board.update("B2", { note: "child progress" }, PEER);
		expect((await h.check(kind, run())).met).toBe(false);
		expect((await h.check(epic, run())).output).toContain("B2 note");
		expect((await h.check(paths, run())).output).toContain("B2 note");
		board.update("B2", { state: "ongoing" }, PEER);
		board.update("B2", { close: { kind: "obsolete", text: "gone" } }, PEER);
		expect((await h.check(kind, run())).met).toBe(false);
		board.update("B3", { state: "ongoing" }, PEER);
		board.update("B3", { note: "finishing" }, PEER);
		expect((await h.check(kind, run())).met).toBe(false);
	});

	it("refuses an epic that does not exist", async () => {
		const h = host();
		const outcome = await h.check(armed(h, "item.changed", { epic: "B9" }), run());
		expect(outcome.refused).toMatch(/no epic B9/);
	});

	it("subscribes to the change feed filtered by ref and leaves the database file alone", () => {
		let heard: (change: BacklogChange) => void = () => undefined;
		const stopFeed = vi.fn();
		const watchDatabase = vi.fn(() => () => undefined);
		const h = host({ watchDatabase }, (listener) => {
			heard = listener;
			return stopFeed;
		});
		const poke = vi.fn();
		const stop = h.watch(armed(h, "item.changed", { ref: "B7" }), "/", poke, () => undefined);
		const change = (ref: string) =>
			({ id: 1, ref, kind: "note", by: "x", paths: [], beforePaths: [] }) as BacklogChange;
		heard(change("B8"));
		expect(poke).not.toHaveBeenCalled();
		heard(change("B7"));
		expect(poke).toHaveBeenCalledTimes(1);
		expect(watchDatabase).not.toHaveBeenCalled();
		stop();
		expect(stopFeed).toHaveBeenCalled();
	});

	it("falls back to the database file where no feed runs", () => {
		const watchDatabase = vi.fn(() => () => undefined);
		const h = host({ watchDatabase });
		h.watch(
			armed(h, "item.state", { ref: "B1", state: "done" }),
			"/",
			() => undefined,
			() => undefined,
		);
		expect(watchDatabase).toHaveBeenCalledTimes(1);
	});
});

describe("peer.landed", () => {
	const peerItem = () => {
		add("Peer work");
		board.update("B1", { state: "ongoing" }, PEER);
	};

	it("takes one item, with the peer's reservation path and agent as options", () => {
		expect(() => untilOfEvent("peer.landed", {}, undefined)).toThrow(/needs filter\.ref/);
		expect(() => parseUntil({ landed: { ref: "B1,B2" } })).toThrow(/names one item/);
		expect(untilOfEvent("peer.landed", { ref: "B1", path: "src/a" }, undefined)).toEqual({
			landed: { ref: "B1", path: "src/a" },
		});
	});

	it("is not met while the peer holds the item and its reservation", async () => {
		peerItem();
		const h = host({ reservation: () => "peer-agent holds src/a" });
		const condition = armed(h, "peer.landed", { ref: "B1", path: "src/a", agent: "peer-agent" });
		const outcome = await h.check(condition, run());
		expect(outcome.met).toBe(false);
		expect(outcome.output).toContain("B1 is ongoing, held by peer-agent");
	});

	it("is met when the item is done", async () => {
		peerItem();
		const h = host();
		const condition = armed(h, "peer.landed", { ref: "B1" });
		board.update(
			"B1",
			{
				state: "done",
				completion: {
					summary: "s",
					files: [],
					verification: { status: "passed" as const, summary: "ran" },
					operationKey: "k1",
				},
			},
			PEER,
		);
		expect((await h.check(condition, run())).output).toContain("B1 is done");
	});

	it("is met when the item is closed", async () => {
		peerItem();
		const h = host();
		const condition = armed(h, "peer.landed", { ref: "B1" });
		board.update("B1", { close: { kind: "obsolete", text: "gone" } }, PEER);
		const outcome = await h.check(condition, run());
		expect(outcome.met).toBe(true);
		expect(outcome.output).toContain("closed");
	});

	it("is met when the peer releases the item, though it never ends", async () => {
		peerItem();
		const h = host();
		const condition = armed(h, "peer.landed", { ref: "B1" });
		board.update("B1", { state: "todo" }, PEER);
		const outcome = await h.check(condition, run());
		expect(outcome.met).toBe(true);
		expect(outcome.output).toContain("released by peer-agent");
	});

	it("is met when its reservation on the path is released", async () => {
		peerItem();
		let held: string | undefined = "peer-agent holds src/a";
		const h = host({ reservation: () => held });
		const condition = armed(h, "peer.landed", { ref: "B1", path: "src/a" });
		expect((await h.check(condition, run())).met).toBe(false);
		held = undefined;
		expect((await h.check(condition, run())).output).toContain("reservation on src/a was released");
	});

	it("is met when the peer is gone, by the agent named or by the item's holder", async () => {
		peerItem();
		const ended = new Set<string>();
		const h = host({ agentEnd: (name) => (ended.has(name) ? { reason: "failed", detail: "crash" } : undefined) });
		const byHolder = armed(h, "peer.landed", { ref: "B1" });
		const named = armed(h, "peer.landed", { ref: "B1", agent: "other-peer" });
		expect((await h.check(byHolder, run())).met).toBe(false);
		ended.add("other-peer");
		expect((await h.check(named, run())).output).toContain("other-peer ended: failed (crash)");
		ended.add("peer-agent");
		expect((await h.check(byHolder, run())).output).toContain("peer-agent ended: failed");
	});

	it("is met when the main session holding the item ends, with no agent named", async () => {
		const SESSION = "holder-session";
		add("Session work");
		board.update("B1", { state: "ongoing" }, { id: SESSION });
		const h = host({ agentEnd: (name) => peerEnd(agent.db, WS, name) });
		const condition = armed(h, "peer.landed", { ref: "B1" });
		// Unknown to the session registry: not ended.
		expect((await h.check(condition, run())).met).toBe(false);
		sessions.start(agent.db, SESSION, process.pid, null, null);
		expect((await h.check(condition, run())).met).toBe(false);
		sessions.clearPid(agent.db, SESSION, process.pid);
		const outcome = await h.check(condition, run());
		expect(outcome.met).toBe(true);
		expect(outcome.output).toContain(`${SESSION} ended: session ended`);
	});

	it("does not take a session whose process still runs, or one that reopened, as ended", async () => {
		const SESSION = "reopened-session";
		add("Session work");
		board.update("B1", { state: "ongoing" }, { id: SESSION });
		const h = host({ agentEnd: (name) => peerEnd(agent.db, WS, name) });
		const condition = armed(h, "peer.landed", { ref: "B1" });
		sessions.start(agent.db, SESSION, process.pid, null, null);
		sessions.clearPid(agent.db, SESSION, process.pid);
		sessions.start(agent.db, SESSION, process.pid, null, null);
		expect((await h.check(condition, run())).met).toBe(false);
	});

	it("is checked also from the database file: a released reservation and an ended agent leave no change", () => {
		peerItem();
		const watchDatabase = vi.fn(() => () => undefined);
		const h = host({ watchDatabase }, () => () => undefined);
		h.watch(
			armed(h, "peer.landed", { ref: "B1" }),
			"/",
			() => undefined,
			() => undefined,
		);
		expect(watchDatabase).toHaveBeenCalledTimes(1);
	});
});

describe("an expired wait on a peer's ongoing item", () => {
	const expiring = { ...run(), expiring: true };

	it("names the owner and suggests a replyRequired question", async () => {
		add("Peer work");
		board.update("B1", { state: "ongoing" }, PEER);
		const h = host();
		for (const [event, filter] of [
			["item.state", { ref: "B1", state: "done" }],
			["peer.landed", { ref: "B1" }],
		] as const) {
			const outcome = await h.check(armed(h, event, filter), expiring);
			expect(outcome.met).toBe(false);
			expect(outcome.output).toContain("peer-agent");
			expect(outcome.output).toContain("replyRequired");
		}
	});

	it("says nothing before the deadline, for a peer that did change it, or for an item this session holds", async () => {
		add("Peer work");
		add("Mine");
		board.update("B1", { state: "ongoing" }, PEER);
		board.update("B2", { state: "ongoing" }, { id: ME });
		const h = host();
		const wait = armed(h, "item.state", { ref: "B1", state: "done" });
		expect((await h.check(wait, run())).output).not.toContain("replyRequired");
		board.update("B1", { note: "still going" }, PEER);
		const changed = (await h.check(wait, expiring)).output;
		expect(changed).toContain("peer-agent");
		expect(changed).not.toContain("Nothing changed");
		const mine = armed(h, "item.state", { ref: "B2", state: "done" });
		expect((await h.check(mine, expiring)).output).not.toContain("replyRequired");
	});

	it("says nothing once the peer's item is not ongoing", async () => {
		add("Peer work");
		const h = host();
		const outcome = await h.check(armed(h, "item.state", { ref: "B1", state: "done" }), expiring);
		expect(outcome.output).not.toContain("replyRequired");
	});
});

describe("stored conditions", () => {
	it("decodes an item wait stored before the cursor existed", () => {
		expect(decodeCondition("item", JSON.stringify({ ref: "B4", state: "done" }))).toEqual({
			kind: "item",
			ref: "B4",
			state: "done",
		});
		const armedItem = parseUntil({ item: { ref: "B4", state: "done", since: 12 } })!;
		expect(decodeCondition("item", encodeCondition(armedItem))).toEqual(armedItem);
	});

	it("keeps item.changed and peer.landed under the stored kind item, which the table already admits", () => {
		const changed = parseUntil({ changed: { ref: "B4", change: "note", since: 3 } })!;
		const landed = parseUntil({ landed: { ref: "B4", path: "src/a", since: 3 } })!;
		for (const condition of [changed, landed]) {
			expect(storedKind(condition)).toBe("item");
			expect(decodeCondition("item", encodeCondition(condition))).toEqual(condition);
		}
		const row = timers.insert(
			agent.db,
			timerFields({ note: "n", until: { changed: { ref: "B4", since: 3 } } }, Date.now(), {
				workspaceId: WS,
				sessionId: "s1",
				cwd: root,
			}),
		);
		expect(row.condition_kind).toBe("item");
		expect(rowCondition(row)).toMatchObject({ kind: "changed", ref: "B4", since: 3 });
		// The board's watcher lookup reads the same column: a peer owning B4 learns this session waits on it.
		expect(queries.itemWatchers(agent.db, WS, ["B4"])).toEqual([{ session: "s1", refs: ["B4"] }]);
	});
});

describe("through a scheduler", () => {
	it("wakes on the peer's note from the feed, long before the safety poll", async () => {
		add("Peer work");
		board.update("B1", { state: "ongoing" }, PEER);
		let heard: (change: BacklogChange) => void = () => undefined;
		const h = host({}, (listener) => {
			heard = listener;
			return () => undefined;
		});
		const until = armUntil(untilOfEvent("item.changed", { ref: "B1" }, undefined), () => h.backlog.head());
		timers.insert(
			agent.db,
			timerFields({ note: "n", until, every: 60 }, Date.now(), { workspaceId: WS, sessionId: "s1", cwd: root }),
		);
		const woken: unknown[] = [];
		const scheduler = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			check: h.check,
			watch: h.watch,
			wake: (row) => woken.push(row),
		});
		started.push(scheduler);
		scheduler.refresh();
		await vi.waitFor(() => expect(timers.activeUntil(agent.db, "s1")[0].due_at).toBeGreaterThan(Date.now() + 30_000), {
			timeout: 4000,
		});
		expect(woken).toHaveLength(0);
		board.update("B1", { note: "landed" }, PEER);
		const [change] = h.backlog.since(0).changes.slice(-1);
		heard(change);
		await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 4000 });
		expect(woken[0]).toMatchObject({ status: "done", last_output: expect.stringContaining("B1 note by peer-agent") });
	});
});
