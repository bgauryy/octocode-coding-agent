import { fixtureBacklog, registerFixtureWorkspace } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentDb,
	closeSharedAgentDb,
	commands,
	configAudits,
	archiveHistory,
	DbWriter,
} from "../../../db/src/api.ts";
import { openAgentDb, agentDbWriter } from "../../src/storage/database.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import { DAY_MS } from "../../src/octocode/shared/util.ts";
import { fakeCtx } from "./fake-host.ts";
import { workspaceServerFixture } from "./workspace-server-fixture.ts";

// History rows (backlog_audits, config_audits, workspace_commands) older than 14 days move into gzip monthly JSONL
// files under the Octocode home; archived rows older than 30 days are dropped; backlog items are never deleted by age.
const NOW = Date.UTC(2026, 10, 10, 12);
const GUARDS = ["backlog_audits_immutable_delete", "config_audits_immutable_delete"];

let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
const open: AgentDb[] = [];

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-retention-")));
	home = path.join(tmp, "home");
	saved = { OCTOCODE_HOME: process.env.OCTOCODE_HOME, OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = home;
	// The database lives elsewhere; the archive still belongs under the Octocode home.
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "elsewhere", "octocode.db");
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const db of open.splice(0)) db.close();
	closeSharedAgentDb();
	for (const [key, value] of Object.entries(saved))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const openDb = (file = process.env.OCTOCODE_AGENT_DB!) => {
	const db = openAgentDb(file);
	registerFixtureWorkspace(db, "repo");
	open.push(db);
	return db;
};
const archiveDir = () => path.join(home, "archive");
const audit = (db: AgentDb, at: number, ref = "B1", repo = "repo") =>
	Number(
		db.db
			.prepare(
				"INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, after_value) VALUES (?, ?, ?, '{\"id\":\"system\"}', 'insert', 'backlog', json_object('title', ?)) RETURNING id",
			)
			.get(repo, ref, at, `at ${at}`)!.id,
	);
/** The ids of a history table, oldest first; audits and commands of repository `repo` only (the seed's item writes under `items`). */
const ids = (db: AgentDb, table: string, repo = "repo") =>
	(
		db.db
			.prepare(`SELECT id FROM ${table} WHERE ${table === "config_audits" ? "1" : "workspace_id = ?"} ORDER BY at`)
			.all(...(table === "config_audits" ? [] : [repo])) as Array<{ id: string | number }>
	).map((row) => String(row.id));
const triggerSql = (db: AgentDb) =>
	db.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
const readArchive = (file: string) =>
	zlib
		.gunzipSync(fs.readFileSync(path.join(archiveDir(), file)))
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { db: string; id: string; at: number; row: Record<string, unknown> })
		.filter((record) => record.row.workspace_id === undefined || record.row.workspace_id === "repo");

/** One row of each history table at each age, oldest first, plus an item created long ago. */
function seed(db: AgentDb) {
	const store = fixtureBacklog(
		() => db,
		"items",
		() => NOW - 60 * DAY_MS,
	);
	store.add({ title: "Old item", createdBy: "user" });
	const rows: Record<number, number> = {};
	for (const age of [40, 20, 15, 5]) {
		rows[age] = audit(db, NOW - age * DAY_MS);
		configAudits.record(db.db, {
			at: NOW - age * DAY_MS,
			actor: "web:test",
			action: "credential.set",
			target: `provider-${age}`,
			outcome: "ok",
		});
		commands.insertAccepted(
			db.db,
			{ id: `cmd-${age}`, session: "s", repo: "repo", action: "prompt", input: "{}" },
			NOW - age * DAY_MS,
			"",
		);
	}
	return { store, rows };
}

describe("history archive housekeeping", () => {
	it("moves history rows older than 14 days into private monthly gzip archives under the Octocode home", () => {
		const db = openDb();
		const { store, rows } = seed(db);
		const triggers = triggerSql(db);

		archiveHistory(db, NOW);

		expect(ids(db, "backlog_audits")).toEqual([String(rows[5])]);
		expect(ids(db, "config_audits")).toHaveLength(1);
		expect(ids(db, "workspace_commands")).toEqual(["cmd-5"]);
		// Backlog items are never deleted by age.
		expect(store.get("B1")?.title).toBe("Old item");
		expect(fs.readdirSync(archiveDir()).sort()).toEqual([
			"audits-2026-10.jsonl.gz",
			"config-audits-2026-10.jsonl.gz",
			"workspace-commands-2026-10.jsonl.gz",
		]);
		// The 40-day-old rows are past the archive window: deleted, not kept.
		const audits = readArchive("audits-2026-10.jsonl.gz");
		expect(audits.map((record) => record.row.id)).toEqual([rows[20], rows[15]]);
		expect(audits[0].row).toMatchObject({ workspace_id: "repo", backlog_id: "B1", at: NOW - 20 * DAY_MS });
		expect(readArchive("workspace-commands-2026-10.jsonl.gz").map((record) => record.row.id)).toEqual([
			"cmd-20",
			"cmd-15",
		]);
		expect(readArchive("config-audits-2026-10.jsonl.gz").map((record) => record.row.target)).toEqual([
			"provider-20",
			"provider-15",
		]);
		// As private as the database: owner-only folder and files; nothing lands next to the database.
		expect(fs.statSync(archiveDir()).mode & 0o777).toBe(0o700);
		for (const file of fs.readdirSync(archiveDir()))
			expect(fs.statSync(path.join(archiveDir(), file)).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(path.dirname(db.file)).some((file) => file.includes("archive"))).toBe(false);
		// The immutability guards are back, exactly as they were.
		expect(triggerSql(db)).toEqual(triggers);
		expect(() => db.db.prepare("DELETE FROM backlog_audits").run()).toThrow(/immutable/);
		expect(() => db.db.prepare("DELETE FROM config_audits").run()).toThrow(/immutable/);
	});

	it("drops archived rows once they are older than 30 days, and the month file when it empties", () => {
		const db = openDb();
		const { rows } = seed(db);
		archiveHistory(db, NOW);
		archiveHistory(db, NOW + 12 * DAY_MS);
		// 20 + 12 = 32 days: dropped; 15 + 12 = 27 days: kept; the 5-day row is now 17 days old and archived (November).
		expect(readArchive("audits-2026-10.jsonl.gz").map((record) => record.row.id)).toEqual([rows[15]]);
		expect(readArchive("audits-2026-11.jsonl.gz").map((record) => record.row.id)).toEqual([rows[5]]);
		archiveHistory(db, NOW + 40 * DAY_MS);
		expect(fs.readdirSync(archiveDir()).filter((file) => file.includes("2026-10"))).toEqual([]);
	});

	it("duplicates rather than loses rows when the delete cannot follow the archive write, and reads each once", () => {
		const db = openDb();
		const { store, rows } = seed(db);
		const other = openDb();
		other.db.exec("BEGIN IMMEDIATE");
		try {
			expect(archiveHistory(db, NOW)).toMatchObject({ skipped: "busy" });
		} finally {
			other.db.exec("ROLLBACK");
		}
		// Archived first, so the row is now in both the database and the archive: each row is read once.
		expect(ids(db, "backlog_audits")).toContain(String(rows[20]));
		expect(readArchive("audits-2026-10.jsonl.gz").map((record) => record.row.id)).toContain(rows[20]);
		const seen = fixtureBacklog(
			() => db,
			"repo",
			() => NOW,
		)
			.audit()
			.map((event) => event.id);
		expect(seen.filter((id) => id === rows[20])).toHaveLength(1);
		archiveHistory(db, NOW);
		expect(ids(db, "backlog_audits")).not.toContain(String(rows[20]));
		const archived = readArchive("audits-2026-10.jsonl.gz").map((record) => record.row.id);
		expect(archived).toEqual([rows[20], rows[15]]);
		expect(store.get("B1")).toBeDefined();
	});

	it("keeps one archive per Octocode home and reads back only this database's rows", () => {
		const db = openDb();
		const first = audit(db, NOW - 20 * DAY_MS);
		archiveHistory(db, NOW);
		const second = openDb(path.join(tmp, "another", "octocode.db"));
		const foreign = audit(second, NOW - 18 * DAY_MS);
		archiveHistory(second, NOW);
		// Both databases share the one archive; ids may collide, so each reads its own rows only.
		expect(first).toBe(foreign);
		expect(readArchive("audits-2026-10.jsonl.gz")).toHaveLength(2);
		const events = fixtureBacklog(
			() => db,
			"repo",
			() => NOW,
		).audit();
		expect(events.map((event) => event.at)).toEqual([NOW - 20 * DAY_MS]);
	});

	it("restores the exact delete guard after pruning and reopening the database", () => {
		const db = openDb();
		audit(db, NOW - 20 * DAY_MS);
		// A distinguishable guard body proves that pruning restores its original semantics.
		db.db.exec("DROP TRIGGER backlog_audits_immutable_delete");
		db.db.exec(
			"CREATE TRIGGER backlog_audits_immutable_delete BEFORE DELETE ON backlog_audits BEGIN SELECT RAISE(ABORT, 'Audit events are immutable (custom guard)'); END",
		);
		const before = triggerSql(db);
		archiveHistory(db, NOW);
		expect(triggerSql(db)).toEqual(before);
		// A row-level guard fires only for a row: keep one in the table.
		audit(db, NOW);
		expect(() => db.db.prepare("DELETE FROM backlog_audits").run()).toThrow(/custom guard/);
		// Reopening the same version preserves each guard.
		const again = openDb();
		const names = (triggerSql(again) as Array<{ name: string }>).map((row) => row.name);
		for (const guard of GUARDS) expect(names.filter((name) => name === guard)).toHaveLength(1);
		expect(names).toContain("backlog_audits_skip_noop");
		// Then a prune on the current schema restores the current guard just the same.
		audit(again, NOW - 16 * DAY_MS);
		const current = triggerSql(again);
		archiveHistory(again, NOW);
		expect(triggerSql(again)).toEqual(current);
	});

	it("is a no-op for the database while another process holds the write lock", () => {
		const db = openDb();
		seed(db);
		const counts = () => ["backlog_audits", "config_audits", "workspace_commands"].map((t) => ids(db, t).length);
		const before = counts();
		const other = openDb();
		other.db.exec("BEGIN IMMEDIATE");
		try {
			expect(() => archiveHistory(db, NOW)).not.toThrow();
		} finally {
			other.db.exec("ROLLBACK");
		}
		expect(counts()).toEqual(before);
	});

	it("runs from the backlog of a session at most once a day, after the call that triggered it", async () => {
		const db = openDb();
		const old = audit(db, Date.now() - 20 * DAY_MS);
		db.close();
		const ctx = fakeCtx({ cwd: tmp });
		openBacklog(ctx, { isSubagent: false });
		await new Promise((resolve) => setImmediate(resolve));
		const shared = openDb();
		expect(await agentDbWriter(shared).drain(5000)).toBe(true);
		expect(ids(shared, "backlog_audits")).not.toContain(String(old));
		const next = audit(shared, Date.now() - 20 * DAY_MS);
		openBacklog(ctx, { isSubagent: false });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ids(shared, "backlog_audits")).toContain(String(next));
	});
});

describe("archived history readers", () => {
	it("cancels an audit wait promptly while the bounded worker read remains pending", async () => {
		const db = openDb();
		const id = audit(db, NOW - 2 * DAY_MS);
		const store = fixtureBacklog(
			() => db,
			"repo",
			() => NOW,
		);
		let finish!: (rows: []) => void;
		const pending = new Promise<[]>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(DbWriter.prototype, "archivedAudits").mockReturnValue(pending);
		const controller = new AbortController();
		const read = store.auditAsync(undefined, 500, undefined, controller.signal);
		controller.abort(new Error("stop audit wait"));
		await expect(read).rejects.toThrow("stop audit wait");
		expect(ids(db, "backlog_audits")).toEqual([String(id)]);
		finish([]);
	});

	it("preserves live rows if housekeeping moves them after the asynchronous archive read was requested", async () => {
		const db = openDb();
		const id = audit(db, NOW - 20 * DAY_MS);
		const store = fixtureBacklog(
			() => db,
			"repo",
			() => NOW,
		);
		vi.spyOn(DbWriter.prototype, "archivedAudits").mockImplementation(async () => {
			// This response represents the archive snapshot just before a concurrent archiver committed.
			archiveHistory(db, NOW);
			return [];
		});
		expect((await store.auditAsync()).map((row) => row.id)).toEqual([id]);
		expect(ids(db, "backlog_audits")).toEqual([]);
	});

	it("pages the store's audit trail across the table and the archive, newest first", async () => {
		const db = openDb();
		audit(db, NOW - 35 * DAY_MS);
		const archived = [audit(db, NOW - 25 * DAY_MS), audit(db, NOW - 20 * DAY_MS, "B2"), audit(db, NOW - 15 * DAY_MS)];
		archiveHistory(db, NOW);
		const live = audit(db, NOW - 2 * DAY_MS);
		const store = fixtureBacklog(
			() => db,
			"repo",
			() => NOW,
		);
		expect(store.audit().map((event) => event.id)).toEqual([archived[0], archived[1], archived[2], live]);
		// The reader applies the 30-day window too, before the next housekeeping trims the file.
		const later = fixtureBacklog(
			() => db,
			"repo",
			() => NOW + 6 * DAY_MS,
		);
		expect(later.audit().map((event) => event.id)).toEqual([archived[1], archived[2], live]);
		expect(store.audit("B1").map((event) => event.id)).toEqual([archived[0], archived[2], live]);
		expect(store.audit(undefined, 2).map((event) => event.id)).toEqual([archived[2], live]);
		expect(store.audit(undefined, 2, archived[2]).map((event) => event.id)).toEqual([archived[0], archived[1]]);
		expect(await store.auditAsync()).toEqual(store.audit());
		expect(await later.auditAsync()).toEqual(later.audit());
		expect(await store.auditAsync("B1")).toEqual(store.audit("B1"));
		expect(await store.auditAsync(undefined, 2)).toEqual(store.audit(undefined, 2));
		expect(await store.auditAsync(undefined, 2, archived[2])).toEqual(store.audit(undefined, 2, archived[2]));
		// The board snapshot carries no audit rows (a large backlog's history made it too big to send): the page reads an
		// item's history, archived rows included, from the audit route below.
		store.add({ title: "B1 now", createdBy: "user" });
		const item = backlogSnapshot(store, "repo", NOW).items.find((each) => each.ref === "B1")!;
		expect(item).not.toHaveProperty("audits");
	});

	it("serves archived rows on the web Audit route", async () => {
		const app = await workspaceServerFixture();
		try {
			const { db } = app;
			const archived = audit(db, Date.now() - 20 * DAY_MS);
			archiveHistory(db, Date.now());
			expect(ids(db, "backlog_audits")).not.toContain(String(archived));
			const response = await app.request("/api/audit?backlogId=B1");
			expect(response.status).toBe(200);
			expect((response.body as { events: Array<{ id: number }> }).events.map((event) => event.id)).toContain(archived);
		} finally {
			await app.close();
		}
	});
});
