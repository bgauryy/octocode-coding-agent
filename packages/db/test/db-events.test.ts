import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type AgentDb } from "../src/db.ts";
import * as eventSubscriptions from "../src/queries/event-subscriptions.ts";
import * as events from "../src/queries/events.ts";
import * as purge from "../src/queries/purge.ts";
import { archiveHistory } from "../src/retention.ts";
import { tmp } from "./helpers.ts";

const locations = (file: string) => ({
	file,
	mirrorFile: `${file}.transcripts`,
	archiveDir: path.join(path.dirname(file), "archive"),
	privateParent: false,
});

const seed =
	"INSERT INTO workspaces (id, name, root, binding) VALUES ('w1', 'repo', '/repo', '1:1'), ('w2', 'other', '/other', '1:2')";

const event = (key: string, over: Partial<events.NewEvent> = {}): events.NewEvent => ({
	workspaceId: "w1",
	at: 1_000,
	topic: "job.exit",
	key,
	source: '{"kind":"job","id":"bash-1"}',
	payload: '{"ok":true}',
	digest: `job ${key} exited`,
	...over,
});

const subscribe = (over: Partial<eventSubscriptions.NewSubscription> = {}): eventSubscriptions.NewSubscription => ({
	workspaceId: "w1",
	subscriber: "main",
	topic: "job.*",
	deliver: "wake",
	durable: true,
	action: '{"type":"hook","hook":"h"}',
	startAt: 0,
	at: 1_000,
	...over,
});

describe("event log", () => {
	let file: string;
	let agent: AgentDb;
	beforeEach(() => {
		file = path.join(tmp("db-events-"), "workspaces.db");
		agent = openDatabase(locations(file));
		agent.db.exec(seed);
	});
	afterEach(() => agent.close());

	it("reads only a session's own events when asked, and narrows it by topic", () => {
		events.append(agent.db, event("a", { sessionId: "s1" }));
		events.append(agent.db, event("b", { sessionId: "s2" }));
		events.append(agent.db, event("c", { sessionId: "s1" }));
		expect(events.read(agent.db, { workspaceId: "w1", after: 0, sessionId: "s1" }).map((row) => row.key)).toEqual([
			"a",
			"c",
		]);
		expect(events.read(agent.db, { workspaceId: "w1", after: 1, sessionId: "s1" }).map((row) => row.key)).toEqual([
			"c",
		]);
		events.append(agent.db, event("d", { sessionId: "s1", topic: "agent.report" }));
		events.append(agent.db, event("e", { sessionId: "s2", topic: "agent.report" }));
		const own = (topic: string) =>
			events.read(agent.db, { workspaceId: "w1", after: 0, sessionId: "s1", topic }).map((row) => row.key);
		expect(own("agent.report")).toEqual(["d"]);
		expect(own("agent.*")).toEqual(["d"]);
	});

	it("orders events by seq and reads after an offset, per topic or family", () => {
		const a = events.append(agent.db, event("a"));
		events.append(agent.db, event("b", { topic: "agent.report" }));
		events.append(agent.db, event("c", { topic: "job.stuck" }));
		events.append(agent.db, event("d", { workspaceId: "w2" }));
		expect(a).toEqual({ seq: 1, inserted: true });
		expect(events.read(agent.db, { workspaceId: "w1", after: 0 }).map((row) => row.key)).toEqual(["a", "b", "c"]);
		expect(events.read(agent.db, { workspaceId: "w1", after: 1, limit: 1 }).map((row) => row.key)).toEqual(["b"]);
		expect(events.read(agent.db, { workspaceId: "w1", after: 0, topic: "job.*" }).map((row) => row.key)).toEqual([
			"a",
			"c",
		]);
		expect(events.read(agent.db, { workspaceId: "w1", after: 0, topic: "job.exit" }).map((row) => row.key)).toEqual([
			"a",
		]);
		expect(events.lastSeq(agent.db, "w1")).toBe(3);
		expect(events.lastSeq(agent.db, "none")).toBe(0);
		expect(events.oldestSeq(agent.db, "w1")).toBe(1);
	});

	it("keeps the first event of a dedupe key and reports its seq", () => {
		const first = events.append(agent.db, event("a", { dedupeKey: "job:1:exit", ref: '{"id":"x"}' }));
		const again = events.append(agent.db, event("a2", { dedupeKey: "job:1:exit" }));
		expect(again).toEqual({ seq: first.seq, inserted: false });
		expect(events.append(agent.db, event("n1")).inserted).toBe(true);
		expect(events.append(agent.db, event("n2")).inserted).toBe(true);
		const rows = events.read(agent.db, { workspaceId: "w1", after: 0 });
		expect(rows.map((row) => row.key)).toEqual(["a", "n1", "n2"]);
		expect(rows[0]?.ref).toBe('{"id":"x"}');
	});

	it.each(["fresh", "legacy"] as const)("deduplicates per workspace in a %s event log", (format) => {
		if (format === "legacy") {
			agent.db.exec(`DROP TABLE event_log;
				CREATE TABLE event_log (
					seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT,
					at INTEGER NOT NULL, topic TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
					digest TEXT NOT NULL, ref TEXT, dedupe_key TEXT UNIQUE
				);`);
		}
		// A subscriber may have advanced beyond the newest remaining row before the file was closed.
		agent.db.exec(`INSERT INTO event_log(seq, workspace_id, at, topic, key, source, payload, digest, dedupe_key)
			VALUES (8, 'w1', 1, 'job.exit', 'old', '{}', '{}', 'done', 'job:1:exit'),
			       (12, 'w1', 2, 'job.exit', 'gone', '{}', '{}', 'done', NULL);
			DELETE FROM event_log WHERE seq = 12;`);
		agent.close();
		agent = openDatabase(locations(file));
		const key = "job:1:exit";
		expect(events.append(agent.db, event("retry", { dedupeKey: key }))).toEqual({ inserted: false, seq: 8 });
		const second = events.append(agent.db, event("other", { dedupeKey: key, workspaceId: "w2" }));
		expect(second.inserted).toBe(true);
		expect(second.seq).toBeGreaterThan(12);
		expect(events.append(agent.db, event("again", { dedupeKey: key, workspaceId: "w2" }))).toEqual({
			inserted: false,
			seq: second.seq,
		});
		for (const [workspaceId, original] of [
			["w1", "old"],
			["w2", "other"],
		]) {
			const rows = events.read(agent.db, { workspaceId, after: 0 });
			expect(rows.map((row) => [row.key, row.dedupe_key])).toEqual([[original, key]]);
		}
	});

	it("does not reuse a seq after the newest event is purged", () => {
		events.append(agent.db, event("a"));
		events.purgeBefore(agent.db, 2_000, 10);
		expect(events.append(agent.db, event("b")).seq).toBe(2);
	});

	it("purges old events in batches, oldest first", () => {
		for (let i = 0; i < 5; i++) events.append(agent.db, event(`e${i}`, { at: 100 + i }));
		expect(events.purgeBefore(agent.db, 103, 2)).toBe(2);
		expect(events.purgeBefore(agent.db, 103, 10)).toBe(1);
		expect(events.read(agent.db, { workspaceId: "w1", after: 0 }).map((row) => row.key)).toEqual(["e3", "e4"]);
		expect(events.oldestSeq(agent.db, "w1")).toBe(4);
	});

	it("keeps a subscription's offset across resubscribing and never moves it back", () => {
		const sub = eventSubscriptions.upsert(agent.db, subscribe({ startAt: 5 }));
		expect(sub.offset_seq).toBe(5);
		expect(eventSubscriptions.advance(agent.db, sub.id, 9, 2_000)).toBe(true);
		expect(eventSubscriptions.advance(agent.db, sub.id, 7, 2_001)).toBe(false);
		const again = eventSubscriptions.upsert(agent.db, subscribe({ startAt: 0, deliver: "record", at: 3_000 }));
		expect(again).toMatchObject({ id: sub.id, offset_seq: 9, deliver: "record", created_at: 1_000, updated_at: 3_000 });
		const other = eventSubscriptions.upsert(agent.db, subscribe({ filter: '{"id":"bash-2"}' }));
		expect(other.id).not.toBe(sub.id);
		expect(eventSubscriptions.forSubscriber(agent.db, "w1", "main", 0).map((row) => row.id)).toEqual([
			sub.id,
			other.id,
		]);
	});

	it("hides expired subscriptions and removes what a dead process owned", () => {
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "a.*", expiresAt: 5_000 }));
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "b.*", durable: false, ownerPid: 42, ownerStarted: "t0" }));
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "c.*", durable: true, ownerPid: 42, ownerStarted: "t0" }));
		expect(eventSubscriptions.forSubscriber(agent.db, "w1", "main", 6_000).map((row) => row.topic)).toEqual([
			"b.*",
			"c.*",
		]);
		expect(eventSubscriptions.removeOwnedBy(agent.db, 42, "t0")).toBe(1);
		expect(eventSubscriptions.forSubscriber(agent.db, "w1", "main", 0).map((row) => row.topic)).toEqual(["a.*", "c.*"]);
		const id = eventSubscriptions.forSubscriber(agent.db, "w1", "main", 0)[0].id;
		expect(eventSubscriptions.remove(agent.db, id)).toBe(true);
		expect(eventSubscriptions.remove(agent.db, id)).toBe(false);
	});

	it("drops old events and expired or idle subscriptions in the retention pass", () => {
		const day = 86_400_000;
		const now = 100 * day;
		events.append(agent.db, event("old", { at: 10 * day }));
		events.append(agent.db, event("new", { at: now - day }));
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "a.*", expiresAt: 10 * day }));
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "b.*", durable: false, at: 10 * day }));
		eventSubscriptions.upsert(agent.db, subscribe({ topic: "c.*", durable: true, at: 10 * day }));
		const result = archiveHistory(agent, now, { archiveAfterDays: 14, keepDays: 30 });
		expect(result.skipped).toBeUndefined();
		expect(events.read(agent.db, { workspaceId: "w1", after: 0 }).map((row) => row.key)).toEqual(["new"]);
		expect(eventSubscriptions.forSubscriber(agent.db, "w1", "main", 0).map((row) => row.topic)).toEqual(["c.*"]);
	});

	it("is emptied by purge.all except events of kept sessions", () => {
		agent.db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('s-keep', 'w1')");
		events.append(agent.db, event("keep", { sessionId: "s-keep" }));
		events.append(agent.db, event("drop", { sessionId: "s-drop" }));
		eventSubscriptions.upsert(agent.db, subscribe({ sessionId: "s-drop" }));
		purge.all(agent.db, agent.mirror.db, { keepSessions: ["s-keep"] });
		expect(events.read(agent.db, { workspaceId: "w1", after: 0 }).map((row) => row.key)).toEqual(["keep"]);
		expect(eventSubscriptions.forSubscriber(agent.db, "w1", "main", 0)).toEqual([]);
	});

	it("adds both tables to an older file of the same version without losing its rows", () => {
		events.append(agent.db, event("a"));
		agent.close();
		const raw = new DatabaseSync(file);
		raw.exec("DROP TABLE event_subscriptions; DROP TABLE event_log");
		raw.close();
		agent = openDatabase(locations(file));
		expect(events.lastSeq(agent.db, "w1")).toBe(0);
		expect(events.append(agent.db, event("b")).seq).toBe(1);
		expect(eventSubscriptions.upsert(agent.db, subscribe()).id).toBe(1);
		expect(agent.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 2 });
	});
});
