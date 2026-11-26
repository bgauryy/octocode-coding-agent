import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { syncDirectorySync } from "../../common/src/atomic-file.ts";
import * as meta from "./queries/meta.ts";
import * as schemaVersion from "./queries/schema-version.ts";
import { processes } from "./queries/sessions.ts";
import { num, type Row } from "./rows.ts";
import { COORDINATION_FILE } from "./schema.ts";
import { backupBeforeSplit, moveAside, partialOf, removeStalePartials } from "./split-files.ts";

export { splitBackupPath } from "./split-files.ts";

/**
 * The split of the machine file (`workspaces.db`) into workspace files, one per key (`workspaces.db_key`): the first
 * open by a host with workspace files on moves every workspace-owned row into `<workspaceDir>/<key>.db`, marks the
 * machine file split (`SPLIT_MARKER`) and raises it to `SPLIT_VERSION`, which every build that keeps workspace rows in
 * the machine file refuses. Until then the file stays at version 12 for every build. Workspace files share the machine
 * file's DDL, so the same queries run on both. Each transaction stays inside one file.
 */

/** The machine file's version and `min_reader` once its workspace rows live in workspace files (`schema.ts`). */
export const SPLIT_VERSION = COORDINATION_FILE.version;
/** `meta` key of a workspace file: the key it was created for. A file stamped with another key is refused at open. */
export const WORKSPACE_KEY = "workspace_key";
/**
 * `meta` row of a machine file whose workspace rows moved out, written in the transaction that deletes them. The split
 * keys on it, not on `min_reader`, which is a reader-compatibility stamp: any other value, or none, means not split.
 */
export const SPLIT_MARKER = { key: "workspace_split", done: "done" } as const;
/** `meta` key naming one split: the machine file and every workspace file that split copied carry the same value. */
export const SPLIT_TOKEN = "workspace_split_token";

const IDS = "(SELECT value FROM json_each(?1))";
const TEAMS = "(SELECT value FROM json_each(?2))";
const KNOWN_TEAMS = "(SELECT value FROM json_each(?3))";
/** Team tables follow their team (one repository); a team no registered workspace names follows its row's workspace. */
const teamRows = (workspace: string) => `team IN ${TEAMS} OR (team NOT IN ${KNOWN_TEAMS} AND ${workspace} IN ${IDS})`;

/**
 * The workspace-owned tables and the rows of one group in each, for schema `s` (`src` while copying, `main` while
 * deleting): `?1` the group's workspace ids, `?2` its teams, `?3` every group's teams (JSON arrays). Children come before
 * the rows their selector reads, so deleting in this order never loses a selector's rows early.
 */
const OWNED: ReadonlyArray<{ table: string; rows: (s: string) => string }> = [
	{ table: "deliveries", rows: (s) => `message IN (SELECT id FROM ${s}.messages WHERE ${teamRows("workspace_id")})` },
	// Comments before notes: a note's delete cascades to its comment.
	...["backlog_links", "backlog_completions", "backlog_comments", "backlog_notes"].map((table) => ({
		table,
		rows: (s: string) => `item IN (SELECT id FROM ${s}.backlog WHERE workspace_id IN ${IDS})`,
	})),
	{ table: "item_handoffs", rows: (s) => `item_id IN (SELECT id FROM ${s}.backlog WHERE workspace_id IN ${IDS})` },
	...[
		"backlog_audits",
		"backlog_tasks",
		"workspace_commands",
		"event_log",
		"event_subscriptions",
		"tickets",
		"timers",
		"jobs",
		"leases",
		"edits",
		"agent_runs",
		"agent_events",
		"backlog",
	].map((table) => ({ table, rows: () => `workspace_id IN ${IDS}` })),
	{ table: "agents", rows: () => teamRows("COALESCE(lease_workspace_id, workspace_id)") },
	{ table: "messages", rows: () => teamRows("workspace_id") },
];

/** The parameters a selector binds: the group's ids, and for a team selector its teams and every group's. */
const bound = (selector: string, group: Group, known: string): string[] =>
	selector.includes("?3") ? [group.ids, group.teams, known] : [group.ids];

/** The workspace-owned tables: the ones a workspace file holds rows of and the machine file keeps empty. */
export const WORKSPACE_TABLES: readonly string[] = OWNED.map(({ table }) => table);

/** The `meta` keys of the group's backlog number high-water marks, which move with its rows. */
const COUNTERS =
	"(SELECT 'backlog_seq:' || value FROM json_each(?1) UNION ALL SELECT 'backlog_task_seq:' || value FROM json_each(?1))";

/**
 * Gives every registered workspace without one its file key: the key another workspace of its Git repository (common
 * dir) already has (as `queries/workspaces.ts` `claimDbKey` gives it), else the id of the repository's main checkout
 * (the one whose `.git` is the common dir), else of the first by root and id; a workspace outside Git keeps its own id.
 */
function assignDbKeys(db: DatabaseSync): void {
	db.exec(`UPDATE workspaces SET db_key = COALESCE(
		(SELECT s.db_key FROM workspaces s WHERE s.git_common_dir = workspaces.git_common_dir AND s.db_key IS NOT NULL
			ORDER BY s.root, s.id LIMIT 1),
		(SELECT m.id FROM workspaces m WHERE m.git_common_dir = workspaces.git_common_dir
			ORDER BY m.root || '/.git' = m.git_common_dir DESC, m.linked_worktree, m.root, m.id LIMIT 1), id)
		WHERE db_key IS NULL`);
}

/** Whether this machine file still holds its workspaces' rows: it has no split marker saying they moved. */
export const needsSplit = (db: DatabaseSync): boolean => meta.read(db, SPLIT_MARKER.key) !== SPLIT_MARKER.done;

interface Group {
	key: string;
	ids: string;
	teams: string;
}

function groups(db: DatabaseSync): { groups: Group[]; known: string } {
	const rows = db
		.prepare(`SELECT db_key AS key, json_group_array(id) AS ids,
			json_group_array(DISTINCT COALESCE(git_common_dir, root)) AS teams
			FROM workspaces WHERE db_key IS NOT NULL GROUP BY db_key ORDER BY db_key`)
		.all() as Array<{ key: string; ids: string; teams: string }>;
	const known = rows.flatMap((row) => JSON.parse(row.teams) as string[]);
	return { groups: rows, known: JSON.stringify(known) };
}

/** Runs `work` with every trigger of `db` dropped, then creates them again exactly as they were. */
function withoutTriggers<T>(db: DatabaseSync, work: () => T): T {
	const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as Array<{
		name: string;
		sql: string;
	}>;
	for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
	const result = work();
	for (const { sql } of triggers) db.exec(sql);
	return result;
}

const columns = (db: DatabaseSync, schema: string, table: string): string =>
	(db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>)
		.map(({ name }) => `"${name}"`)
		.join(", ");

/** The rows moved out of the machine file, per group and table. */
export type SplitCounts = Record<string, Record<string, number>>;

/**
 * A connection on the workspace file at `file` for `key`: an empty file gets the schema and the key's stamp, a file
 * stamped for another key is refused. The split closes it.
 */
export type OpenWorkspaceFile = (file: string, key: string) => { db: DatabaseSync; close(): void };

/**
 * Copies one group's rows from the machine file's committed state into a new private file `partial`, stamped with the
 * split's `token`: filled with its triggers dropped (so no audit or comment row is made twice) and foreign keys checked
 * at the end, its write-ahead log folded in. Returns the rows copied per table.
 */
function copyGroup(
	source: string,
	partial: string,
	group: Group,
	known: string,
	open: OpenWorkspaceFile,
	token: string,
): Record<string, number> {
	fs.rmSync(partial, { force: true });
	const copied: Record<string, number> = {};
	const { db, close } = open(partial, group.key);
	try {
		db.exec("PRAGMA foreign_keys=OFF");
		db.prepare("ATTACH DATABASE ? AS src").run(source);
		// Deferred: IMMEDIATE would also take the write lock of the attached machine file, which the split holds.
		db.exec("BEGIN");
		try {
			withoutTriggers(db, () => {
				for (const { table, rows } of OWNED) {
					const list = columns(db, "main", table);
					copied[table] = num(
						db
							.prepare(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM src.${table} WHERE ${rows("src")}`)
							.run(...bound(rows("src"), group, known)).changes,
					);
				}
				// The backlog number high-water marks, so a number deleted before the split is never issued again.
				db.prepare(
					`INSERT OR REPLACE INTO main.meta (key, value) SELECT key, value FROM src.meta WHERE key IN ${COUNTERS}`,
				).run(group.ids);
				meta.write(db, SPLIT_TOKEN, token);
				// The registry rows every copied row names (the group's own, and any other workspace a row refers to).
				const registry = columns(db, "main", "workspaces");
				for (const table of WORKSPACE_TABLES)
					for (const { from } of db
						.prepare('SELECT "from" FROM pragma_foreign_key_list(?) WHERE "table" = \'workspaces\'')
						.all(table) as Array<{ from: string }>)
						db.exec(
							`INSERT OR IGNORE INTO main.workspaces (${registry}) SELECT ${registry} FROM src.workspaces WHERE id IN (SELECT "${from}" FROM main.${table})`,
						);
				db.prepare(
					`INSERT OR IGNORE INTO main.workspaces (${registry}) SELECT ${registry} FROM src.workspaces WHERE id IN ${IDS}`,
				).run(group.ids);
				// New ids continue above every id the machine file gave out, so archived and live rows never share one.
				const names = WORKSPACE_TABLES.map((table) => `'${table}'`).join(", ");
				db.exec(`DELETE FROM main.sqlite_sequence WHERE name IN (${names});
					INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM src.sqlite_sequence WHERE name IN (${names})`);
			});
			const broken = db.prepare("PRAGMA main.foreign_key_check").all() as Row[];
			if (broken.length)
				throw new Error(`Splitting workspace ${group.key} left rows naming missing ones: ${JSON.stringify(broken)}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		db.exec("DETACH DATABASE src; PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		close();
	}
	// The last connection's close folds the WAL into the file; a WAL left behind would not move with the rename.
	if ((fs.statSync(`${partial}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0)
		throw new Error(`${partial} kept a write-ahead log after its copy was closed`);
	for (const suffix of ["-wal", "-shm"]) fs.rmSync(partial + suffix, { force: true });
	return copied;
}

/** The split token a closed workspace file carries, if any. */
function tokenOf(file: string, open: OpenWorkspaceFile, key: string): string | undefined {
	const { db, close } = open(file, key);
	try {
		return meta.read(db, SPLIT_TOKEN);
	} finally {
		close();
	}
}

/**
 * Refuses to split while a session row names another live process (`running`: its pid and recorded start time): a
 * process that opened the machine file before the split keeps writing workspace rows to it whatever its version says.
 */
function refuseWhileOthersRun(db: DatabaseSync, file: string, running: SplitOptions["running"]): void {
	const live = processes(db).filter((row) => row.pid !== process.pid && running(row.pid, row.pid_started));
	if (!live.length) return;
	const named = live.slice(0, 5).map((row) => `${row.id} (pid ${row.pid})`);
	if (live.length > named.length) named.push(`${live.length - named.length} more`);
	throw new SplitBusyError(
		`${file} cannot move its workspace rows into workspace files while other Octocode processes use it: session ${named.join(", ")} still runs. Quit every other Octocode process and start again; nothing changed.`,
	);
}

/** The split was refused because another session's process still runs; nothing changed. */
export class SplitBusyError extends Error {}

/** What a split needs besides the machine connection. */
export interface SplitOptions {
	/** The machine file's path, which the copies attach and the backup reads. */
	file: string;
	workspaceDir: string;
	/** The machine connection's write transaction: the split runs inside one. */
	transaction: <T>(fn: () => T) => T;
	open: OpenWorkspaceFile;
	/** Whether the process a session row records (pid, start time) still runs: the host's process check. */
	running(pid: number, started: string | null): boolean;
}

/**
 * Moves every group's rows into its workspace file inside one write transaction of the machine file, which keeps every
 * other writer out until the rows are gone from it. In order: refuse while another session's process runs; remove the
 * partials a killed split left; back the file up; delete the rows (uncommitted) and check none is left over; copy each
 * group from the committed state into a partial stamped with a new token, its counts equal to the rows deleted; move
 * any file found at a target aside; rename the partials into place; check each target carries the token; raise the
 * version. A failure before the commit leaves the machine file as it was, and the next open copies everything afresh.
 * Idempotent: a file already split (`needsSplit` false) is left alone.
 */
export function splitWorkspaces(db: DatabaseSync, options: SplitOptions): SplitCounts | undefined {
	const { file, workspaceDir, transaction, open, running } = options;
	return transaction(() => {
		if (!needsSplit(db)) return undefined;
		refuseWhileOthersRun(db, file, running);
		removeStalePartials(file, workspaceDir);
		backupBeforeSplit(file);
		assignDbKeys(db);
		const token = randomUUID();
		meta.write(db, SPLIT_TOKEN, token);
		const { groups: all, known } = groups(db);
		const moved: SplitCounts = {};
		db.exec("PRAGMA defer_foreign_keys=ON");
		withoutTriggers(db, () => {
			for (const group of all) {
				const deleted: Record<string, number> = {};
				for (const { table, rows } of OWNED)
					deleted[table] = num(
						db.prepare(`DELETE FROM main.${table} WHERE ${rows("main")}`).run(...bound(rows("main"), group, known))
							.changes,
					);
				db.prepare(`DELETE FROM main.meta WHERE key IN ${COUNTERS}`).run(group.ids);
				moved[group.key] = deleted;
			}
		});
		const left = WORKSPACE_TABLES.filter((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
		if (left.length) throw new Error(`Splitting ${file} left rows of no registered workspace in: ${left.join(", ")}.`);
		if (all.length > 0) fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
		const targets = all.map((group) => ({ group, target: path.join(workspaceDir, `${group.key}.db`) }));
		try {
			for (const { group, target } of targets) {
				const copied = copyGroup(file, partialOf(target), group, known, open, token);
				for (const table of WORKSPACE_TABLES)
					if (copied[table] !== moved[group.key][table])
						throw new Error(
							`Splitting workspace ${group.key}: its copy holds ${copied[table]} ${table} rows, the machine file ${moved[group.key][table]}. Nothing was removed from ${file}.`,
						);
			}
		} catch (error) {
			for (const { target } of targets)
				for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(partialOf(target) + suffix, { force: true });
			throw error;
		}
		for (const { target } of targets) {
			moveAside(target);
			fs.renameSync(partialOf(target), target);
		}
		if (targets.length) syncDirectorySync(workspaceDir);
		for (const { group, target } of targets)
			if (tokenOf(target, open, group.key) !== token)
				throw new Error(
					`Splitting workspace ${group.key}: ${target} is not this split's copy. Nothing was removed from ${file}.`,
				);
		schemaVersion.setMinReader(db, SPLIT_VERSION);
		schemaVersion.set(db, SPLIT_VERSION);
		meta.write(db, SPLIT_MARKER.key, SPLIT_MARKER.done);
		return moved;
	});
}
