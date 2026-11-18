import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { backlog as queries, closeSharedAgentDb } from "../../../db/src/api.ts";
import { BacklogBus, type BusEvent } from "../../src/octocode/backlog/bus.ts";
import { classify } from "../../src/octocode/shared/backlog-classify.ts";
import { type PeerWake, PeerNotifier, PEER_WAKE_WINDOW_MS } from "../../src/octocode/backlog/peer-notify.ts";
import { boardView } from "../../src/octocode/backlog/peers.ts";
import { related } from "../../src/octocode/backlog/related.ts";
import type { BacklogStore } from "../../src/octocode/backlog/store.ts";
import type { BacklogChange } from "../../src/octocode/shared/backlog-change.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";

const WS = "ws-feed";
const A = { id: "agent-a" };
const S2 = { id: "session-2" };
const S4 = { id: "session-4" };
const S6 = { id: "session-6" };
let tmp: string;
let saved: string | undefined;
let store: BacklogStore;
const db = () => sharedAgentDb().db;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-feed-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
	store = fixtureBacklog(() => sharedAgentDb(), WS);
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const byText = (a: unknown[], b: unknown[]) => a.join().localeCompare(b.join());
const head = () => queries.snapshot(db(), WS).cursor;
const changesSince = (since: number): BacklogChange[] => {
	const page = queries.auditAfter(db(), WS, since, 500);
	if (page.resync) throw new Error("resync");
	return page.rows.map(classify).filter((change): change is BacklogChange => change !== undefined);
};
const item = (title: string, extra: Record<string, unknown> = {}) =>
	store.add({ title, goal: "checkable", why: "needed", createdBy: "user", ...extra });

describe("audit rows classify into typed changes (S1)", () => {
	it("reads claims, notes, paths, links, closes and epics from the audit", () => {
		item("Epic", { type: "epic" });
		item("Prerequisite", { paths: ["src/a/"] });
		const since = head();
		store.update("B2", { state: "ongoing" }, A);
		store.update("B2", { note: "halfway there" }, A);
		store.update("B2", { paths: ["src/a/", "src/b/"] }, A);
		item("Dependent", { dependsOn: ["B2"], parentId: "B1" });
		store.update("B2", { close: { kind: "obsolete", text: "not needed" } }, A);
		const changes = changesSince(since);
		expect(changes.map((change) => [change.ref, change.kind])).toEqual([
			["B2", "claimed"],
			["B2", "note"],
			["B2", "paths_changed"],
			["B3", "created"],
			["B3", "edited"],
			["B3", "blocked"],
			["B2", "closed"],
		]);
		expect(changes[0]).toMatchObject({ by: "agent-a", assignee: "agent-a", paths: ["src/a/"] });
		expect(changes[1].text).toBe("halfway there");
		expect(changes[2].beforePaths).toEqual(["src/a/"]);
		expect(changes[5]).toMatchObject({ target: "B2" });
		expect(changes[4].parent).toBe("B1");
	});
});

describe("related agents (S1)", () => {
	const board = () => {
		item("Epic", { type: "epic" }); // B1
		item("Prerequisite", { paths: ["src/a/"], parentId: "B1" }); // B2
		item("Dependent", { dependsOn: ["B2"], parentId: "B1" }); // B3
		item("Sibling", { parentId: "B1" }); // B4
		item("Overlapping", { paths: ["src/a/x.ts"] }); // B5
		// A holder can only start a dependent once its prerequisite ended: close it, start, then reopen it.
		store.update("B2", { close: { kind: "obsolete", text: "for now" } }, A);
		store.update("B3", { state: "ongoing" }, S2);
		store.update("B4", { state: "ongoing" }, S4);
		store.update("B5", { state: "ongoing" }, S6);
		store.update("B2", { state: "todo", note: "reopened: still needed" }, A);
	};
	const view = (watchers: Array<{ session: string; refs: string[] }> = []) => ({
		...boardView(store, db(), () => [{ agent: "peer-agent", paths: ["src/a"] }]),
		watchers: () => watchers,
	});

	it("finds dependents, epic siblings and watchers of an ended item, never the actor or its holder", () => {
		board();
		store.update("B2", { state: "ongoing" }, A);
		const since = head();
		store.update("B2", { close: { kind: "obsolete", text: "gone" } }, A);
		const [closed] = changesSince(since);
		const found = related(
			closed,
			view([
				{ session: "session-9", refs: ["B2"] },
				{ session: "agent-a", refs: ["B2"] },
			]),
		);
		expect(found.map((each) => [each.relation, each.session, each.ref]).sort(byText)).toEqual(
			[
				["dependent", "session-2", "B3"],
				["sibling", "session-4", "B4"],
				["sibling", "session-2", "B3"],
				["watcher", "session-9", "B2"],
			].sort(byText),
		);
	});

	it("finds paths overlap and reservations of a claim, prefix both ways", () => {
		board();
		const since = head();
		store.update("B2", { state: "ongoing" }, A);
		const [claimed] = changesSince(since);
		const found = related(claimed, view());
		expect(found).toContainEqual(
			expect.objectContaining({ relation: "overlap", session: "session-6", ref: "B5", paths: ["src/a/x.ts"] }),
		);
		expect(found).toContainEqual(expect.objectContaining({ relation: "reservation", agent: "peer-agent" }));
	});

	it("tells a blocker's holder of a new dependency, and a note's watchers", () => {
		board();
		item("Waiting"); // B6
		const before = head();
		store.update("B6", { dependsOn: ["B5"] }, S4);
		const since = before;
		const blocked = changesSince(since).find((change) => change.kind === "blocked")!;
		expect(related(blocked, view()).map((each) => [each.relation, each.session])).toEqual([
			["dependency", "session-6"],
		]);
		store.update("B2", { note: "files free" }, A);
		const note = changesSince(head() - 1).find((change) => change.kind === "note")!;
		expect(related(note, view([{ session: "session-9", refs: ["B2"] }])).map((each) => each.relation)).toEqual([
			"watcher",
		]);
	});
});

describe("BacklogBus (S2)", () => {
	const host = (calls: { after: number; follow: number }, pokes: Array<() => void>) => ({
		head,
		after: (cursor: number, limit: number) => {
			calls.after++;
			return queries.auditAfter(db(), WS, cursor, limit);
		},
		follow: (poke: () => void) => {
			calls.follow++;
			pokes.push(poke);
			return () => pokes.splice(pokes.indexOf(poke), 1);
		},
		own: (by: string) => by === A.id,
		failed: (error: unknown) => failures.push(error),
	});
	const failures: unknown[] = [];

	it("reads the audit only when the follower fires, once per change, with the own flag", () => {
		item("One");
		const calls = { after: 0, follow: 0 };
		const pokes: Array<() => void> = [];
		const bus = new BacklogBus(host(calls, pokes));
		const heard: BusEvent[] = [];
		const stop = bus.on((event) => heard.push(event));
		store.update("B1", { state: "ongoing" }, A);
		store.update("B1", { note: "hi" }, S2);
		expect(calls.after).toBe(0);
		pokes[0]();
		expect(heard.map((event) => (event.type === "change" ? [event.change.kind, event.own] : event.type))).toEqual([
			["claimed", true],
			["note", false],
		]);
		const reads = calls.after;
		pokes[0]();
		expect(heard).toHaveLength(2);
		expect(calls.after).toBe(reads + 1);
		stop();
		expect(pokes).toHaveLength(0);
		expect(calls.follow).toBe(1);
	});

	it("isolates a throwing listener and reports a pruned cursor as resync", () => {
		item("One");
		failures.length = 0;
		const pokes: Array<() => void> = [];
		const base = host({ after: 0, follow: 0 }, pokes);
		let prune = false;
		const bus = new BacklogBus({
			...base,
			after: (cursor, limit) => (prune ? { resync: true, cursor: head() } : base.after(cursor, limit)),
		});
		const heard: BusEvent[] = [];
		bus.on(() => {
			throw new Error("boom");
		});
		bus.on((event) => heard.push(event));
		store.update("B1", { state: "ongoing" }, A);
		pokes[0]();
		expect(heard).toHaveLength(1);
		expect(failures).toHaveLength(1);
		prune = true;
		pokes[0]();
		expect(heard.at(-1)).toEqual({ type: "resync" });
	});
});

describe("peer notifier (S3)", () => {
	const setup = (session: string, options: { overlapWake?: boolean; acted?: boolean } = {}) => {
		const wakes: PeerWake[] = [];
		let now = 1_000_000;
		const notifier = new PeerNotifier({
			me: () => ({ session }),
			view: () => boardView(store, db()),
			overlapWake: () => options.overlapWake ?? true,
			acted: () => options.acted ?? false,
			wake: (wake) => wakes.push(wake),
			now: () => now,
		});
		const feed = (since: number) => {
			for (const change of changesSince(since)) notifier.handle({ type: "change", change, own: change.by === session });
		};
		return { wakes, notifier, feed, advance: (ms: number) => (now += ms) };
	};
	const prepare = () => {
		item("Epic", { type: "epic" }); // B1
		item("Prerequisite", { paths: ["src/a/"], parentId: "B1" }); // B2
		item("Dependent", { dependsOn: ["B2"], parentId: "B1" }); // B3
		item("Sibling", { parentId: "B1" }); // B4
		item("Overlapping", { paths: ["src/a/x.ts"] }); // B5
		// A holder can only start a dependent once its prerequisite ended: close it, start, then reopen it.
		store.update("B2", { close: { kind: "obsolete", text: "for now" } }, A);
		store.update("B3", { state: "ongoing" }, S2);
		store.update("B4", { state: "ongoing" }, S4);
		store.update("B5", { state: "ongoing" }, S6);
		store.update("B2", { state: "todo", note: "reopened: still needed" }, A);
	};

	it("wakes a dependent's holder when its prerequisite is done, and nobody about their own writes", () => {
		prepare();
		store.update("B2", { state: "ongoing" }, A);
		const holder = setup("session-2");
		const since = head();
		store.update("B2", { close: { kind: "obsolete", text: "gone" } }, A);
		holder.feed(since);
		expect(holder.wakes.map((wake) => [wake.ref, wake.kind, wake.relation, wake.by])).toEqual([
			["B2", "closed", "dependent", "agent-a"],
		]);
		const actor = setup("agent-a");
		actor.feed(since);
		expect(actor.wakes).toHaveLength(0);
		expect(actor.notifier.fyi()).toBeUndefined();
	});

	it("gives an epic sibling an FYI only, never a new turn", () => {
		prepare();
		const sibling = setup("session-4");
		const since = head();
		store.update("B2", { state: "ongoing" }, A);
		const claimed = head();
		store.update("B2", { close: { kind: "obsolete", text: "gone" } }, A);
		sibling.feed(since);
		expect(sibling.wakes).toHaveLength(0);
		expect(sibling.notifier.fyi()).toContain("B2");
		expect(sibling.notifier.fyi()).toBeUndefined();
		expect(claimed).toBeGreaterThan(since);
	});

	it("wakes the holder of an overlapping claim once, unless the setting is off", () => {
		prepare();
		const since = head();
		store.update("B2", { state: "ongoing" }, A);
		const on = setup("session-6");
		on.feed(since);
		expect(on.wakes.map((wake) => wake.relation)).toEqual(["overlap"]);
		store.update("B2", { paths: ["src/a/", "src/a/y.ts"] }, A);
		on.advance(PEER_WAKE_WINDOW_MS + 1);
		on.feed(head() - 1);
		expect(on.wakes).toHaveLength(1);
		const off = setup("session-6", { overlapWake: false });
		off.feed(since);
		expect(off.wakes).toHaveLength(0);
		expect(off.notifier.fyi()).toContain("B2");
	});

	it("wakes at most once per item in five minutes, and not for an item its last run wrote", () => {
		prepare();
		const holder = setup("session-2");
		const since = head();
		store.update("B2", { state: "ongoing" }, A);
		store.update("B2", { close: { kind: "obsolete", text: "gone" } }, A);
		store.update("B2", { state: "ongoing", note: "reopened" }, A);
		holder.feed(since);
		expect(holder.wakes).toHaveLength(1);
		const later = head();
		store.update("B2", { close: { kind: "obsolete", text: "gone again" } }, A);
		holder.advance(PEER_WAKE_WINDOW_MS + 1);
		holder.feed(later);
		expect(holder.wakes).toHaveLength(2);
		const acted = setup("session-2", { acted: true });
		acted.feed(since);
		expect(acted.wakes).toHaveLength(0);
	});
});
