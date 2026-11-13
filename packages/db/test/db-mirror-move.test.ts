import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { mirrorInventory, openDatabase } from "../src/api.ts";
import { SCHEMA_PLAN } from "../src/migrations.ts";
import { tmp } from "./helpers.ts";

/**
 * Schema version 10 moves the transcript mirror out of the coordination file. These tests build a version 9 file the
 * way the previous Octocode left it (the mirror tables beside the coordination ones), then open it with this Octocode.
 */

/** The mirror tables as a version 9 coordination file holds them. */
const OLD_MIRROR = `
CREATE TABLE session_transcripts (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE, header TEXT NOT NULL, byte_size INTEGER NOT NULL, mtime TEXT NOT NULL, file_binding TEXT NOT NULL);
CREATE TABLE session_entries (
  session_id TEXT NOT NULL REFERENCES session_transcripts(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id, position));
CREATE INDEX session_entries_tree ON session_entries(session_id, parent_id);
CREATE INDEX session_entries_id ON session_entries(session_id, entry_id);
CREATE TABLE compaction_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  summary TEXT NOT NULL, committed_at INTEGER, origin_verified INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}', detail_file TEXT, detail_state TEXT NOT NULL DEFAULT 'missing',
  UNIQUE(session_id, entry_id),
  FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id) ON DELETE CASCADE);
CREATE INDEX compaction_summaries_workspace ON compaction_summaries(workspace_id, seq DESC);`;

const SESSIONS = 6;
const ENTRIES = 40;

const locationsOf = (file: string) => ({
	file,
	mirrorFile: path.join(path.dirname(file), "transcripts.db"),
	archiveDir: path.join(path.dirname(file), "archive"),
	privateParent: false,
});

/** A version 9 file with `SESSIONS` mirrored transcripts (entries of about 2 KB), their summaries and coordination rows. */
function versionNine(): string {
	const file = path.join(tmp(), "workspaces.db");
	openDatabase(locationsOf(file), { version: 9, migrations: SCHEMA_PLAN.migrations.slice(0, 8) }).close();
	const db = new DatabaseSync(file);
	db.exec(OLD_MIRROR);
	db.exec("INSERT INTO workspaces(id,name,root,binding) VALUES ('w','w','/r/w','1:1')");
	db.exec("INSERT INTO meta(key,value) VALUES ('keep','me')");
	const pad = "y".repeat(2000);
	for (let s = 0; s < SESSIONS; s++) {
		const id = `s-${s}`;
		db.prepare("INSERT INTO sessions(id,workspace_id) VALUES (?, 'w')").run(id);
		db.prepare(
			"INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES (?,?,?,?,?,?)",
		).run(id, `/t/${id}.jsonl`, JSON.stringify({ id }), 100 + s, `${s}000000`, `1:${s}`);
		for (let n = 0; n < ENTRIES; n++)
			db.prepare(
				"INSERT INTO session_entries(session_id,position,entry_id,parent_id,type,data) VALUES (?,?,?,?,?,?)",
			).run(id, n, `${id}-${n}`, n ? `${id}-${n - 1}` : null, "message", JSON.stringify({ n, pad }));
		db.prepare(
			"INSERT INTO compaction_summaries(workspace_id,session_id,entry_id,summary,committed_at,detail_state) VALUES ('w',?,?,?,?,?)",
		).run(id, `c-${s}`, `summary ${s}`, s, s % 2 ? "expired" : "present");
	}
	db.close();
	return file;
}

const read = <T>(file: string, work: (db: DatabaseSync) => T): T => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return work(db);
	} finally {
		db.close();
	}
};
const version = (file: string) =>
	read(file, (db) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const tables = (file: string) =>
	read(file, (db) =>
		(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
			(row) => row.name,
		),
	);
const inventoryOf = (file: string) => read(file, (db) => mirrorInventory(db));
const metaOf = (file: string, key: string) =>
	read(
		file,
		(db) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value,
	);

/** Runs the migration in another process that kills itself (SIGKILL) once `after` sessions are copied. */
function killedMigration(file: string, after: number): Promise<NodeJS.Signals | null> {
	const api = pathToFileURL(fileURLToPath(new URL("../src/api.ts", import.meta.url))).href;
	const script = `
		const { openDatabase } = await import(${JSON.stringify(api)});
		openDatabase(${JSON.stringify(locationsOf(file))}, undefined, {
			progress: (done) => { if (done === ${after}) process.kill(process.pid, "SIGKILL"); },
		});`;
	return new Promise((resolve) => {
		const child = execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", script]);
		child.on("exit", (_code, signal) => resolve(signal));
	});
}

describe("schema version 10: the transcript mirror's own file", () => {
	it("moves every session's rows into the mirror file, verified, and leaves a small coordination file", () => {
		const file = versionNine();
		const before = inventoryOf(file);
		const bytesBefore = fs.statSync(file).size;
		expect(before).toMatchObject({ transcripts: SESSIONS, entries: SESSIONS * ENTRIES, summaries: SESSIONS });
		const progress: number[] = [];
		openDatabase(locationsOf(file), undefined, { progress: (done) => progress.push(done) }).close();
		expect(progress).toEqual(Array.from({ length: SESSIONS }, (_, n) => n + 1));
		expect(version(file)).toBe(10);
		for (const gone of ["session_entries", "session_transcripts", "compaction_summaries"])
			expect(tables(file)).not.toContain(gone);
		expect(metaOf(file, "keep")).toBe("me");
		// Not additive: an Octocode from before the move refuses the file instead of finding its tables gone.
		expect(metaOf(file, "schema_readable_from")).toBe("10");
		const after = inventoryOf(locationsOf(file).mirrorFile);
		expect(after.sha256).toBe(before.sha256);
		expect(after).toMatchObject({ transcripts: SESSIONS, entries: SESSIONS * ENTRIES, summaries: SESSIONS });
		// Vacuumed: the coordination file no longer holds the mirror's pages, nor free ones.
		const mirrorBytes = SESSIONS * ENTRIES * 2000;
		expect(fs.statSync(file).size).toBeLessThan(bytesBefore - mirrorBytes);
		expect(read(file, (db) => db.prepare("PRAGMA freelist_count").get())).toEqual({ freelist_count: 0 });
		// The backup covers the coordination data: a version 9 file with the mirror tables empty.
		const backup = `${file}.v9.bak`;
		expect(version(backup)).toBe(9);
		expect(metaOf(backup, "keep")).toBe("me");
		expect(inventoryOf(backup)).toMatchObject({ transcripts: 0, entries: 0, summaries: 0 });
		expect(fs.statSync(backup).size).toBeLessThan(bytesBefore - mirrorBytes);
		// The ids continue after the copied ones.
		const agent = openDatabase(locationsOf(file));
		try {
			const next = agent.mirror.db
				.prepare(
					"INSERT INTO compaction_summaries(workspace_id,session_id,entry_id,summary) VALUES ('w','new','c','s')",
				)
				.run().lastInsertRowid;
			expect(Number(next)).toBe(SESSIONS + 1);
		} finally {
			agent.close();
		}
	});

	it("has every copied row in the mirror's own file, not only its WAL, before the old tables are dropped", () => {
		const file = versionNine();
		const { mirrorFile } = locationsOf(file);
		// Another connection on the mirror keeps the move's from checkpointing as it closes, the way a live session would.
		const peer = new DatabaseSync(mirrorFile);
		try {
			openDatabase(locationsOf(file), undefined, {
				progress: (done) => {
					if (done === 1) peer.prepare("SELECT count(*) FROM sqlite_schema").get();
				},
			}).close();
			// What an OS crash keeps of a WAL that was never synced: nothing. The file alone must hold every row.
			const fileOnly = path.join(tmp(), "transcripts-file-only.db");
			fs.copyFileSync(mirrorFile, fileOnly);
			expect(inventoryOf(fileOnly)).toMatchObject({
				transcripts: SESSIONS,
				entries: SESSIONS * ENTRIES,
				summaries: SESSIONS,
			});
		} finally {
			peer.close();
		}
	});

	it("survives a kill part way: the coordination file is unchanged, and opening again finishes the move", async () => {
		const file = versionNine();
		const before = inventoryOf(file);
		expect(await killedMigration(file, 2)).toBe("SIGKILL");
		// Nothing in the coordination file changed: the step's transaction never committed.
		expect(version(file)).toBe(9);
		expect(inventoryOf(file).sha256).toBe(before.sha256);
		const mirrorFile = locationsOf(file).mirrorFile;
		const partial = inventoryOf(mirrorFile);
		expect(partial.transcripts).toBe(2);
		expect([...partial.sessions.keys()]).toEqual(["s-0", "s-1"]);
		// Rows the mirror holds that differ from the source, or that it has no source for, are replaced or removed.
		const tamper = new DatabaseSync(mirrorFile);
		tamper.exec("UPDATE session_entries SET data='changed' WHERE session_id='s-1' AND position=3");
		tamper.exec(
			"INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES ('stray','/t/stray.jsonl','{}',1,'1','1:1')",
		);
		tamper.close();
		const progress: number[] = [];
		openDatabase(locationsOf(file), undefined, { progress: (done) => progress.push(done) }).close();
		expect(progress).toHaveLength(SESSIONS);
		expect(version(file)).toBe(10);
		const after = inventoryOf(mirrorFile);
		expect(after.sha256).toBe(before.sha256);
		expect([...after.sessions.keys()]).not.toContain("stray");
	});

	it("survives a kill on the first session and on the last one", async () => {
		for (const after of [1, SESSIONS]) {
			const file = versionNine();
			const before = inventoryOf(file);
			expect(await killedMigration(file, after)).toBe("SIGKILL");
			expect(version(file)).toBe(9);
			openDatabase(locationsOf(file)).close();
			expect(version(file)).toBe(10);
			expect(inventoryOf(locationsOf(file).mirrorFile).sha256).toBe(before.sha256);
		}
	});

	it("a new coordination file has no mirror tables, and the mirror file is its own Octocode file", () => {
		const file = path.join(tmp(), "workspaces.db");
		const agent = openDatabase(locationsOf(file));
		try {
			expect(tables(file)).not.toContain("session_entries");
			expect(agent.mirror.file).toBe(locationsOf(file).mirrorFile);
			expect(tables(agent.mirror.file)).toEqual(
				expect.arrayContaining(["compaction_summaries", "session_entries", "session_transcripts"]),
			);
		} finally {
			agent.close();
		}
		// A coordination file is not a mirror file: opening one as the other is refused before anything changes.
		const swapped = { ...locationsOf(file), mirrorFile: file };
		const crossed = openDatabase({ ...swapped, file: path.join(tmp(), "workspaces.db") });
		try {
			expect(() => crossed.mirror).toThrow(/is not an Octocode transcript mirror/);
			expect(() => crossed.mirror).toThrow(/is not an Octocode transcript mirror/);
		} finally {
			crossed.close();
		}
	});
});
