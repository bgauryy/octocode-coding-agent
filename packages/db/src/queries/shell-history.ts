import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";

/** A `shell_history` row: one `!` command in one folder. */
export interface ShellHistoryRow {
	cwd: string;
	command: string;
	count: number;
	last_at: number;
	last_exit: number | null;
}

/** Counts one run of `command` in `cwd` at `at`; the exit code is unknown until `setExit`. */
export function record(db: DatabaseSync, cwd: string, command: string, at: number): void {
	db.prepare(
		`INSERT INTO shell_history (cwd, command, count, last_at, last_exit) VALUES (?, ?, 1, ?, NULL)
		 ON CONFLICT(cwd, command) DO UPDATE SET count = count + 1, last_at = excluded.last_at, last_exit = NULL`,
	).run(cwd, command, at);
}

/** Stores the exit code of the last run of `command` in `cwd`. */
export function setExit(db: DatabaseSync, cwd: string, command: string, exit: number): void {
	db.prepare("UPDATE shell_history SET last_exit = ? WHERE cwd = ? AND command = ?").run(exit, cwd, command);
}

/** The `limit` most recently run commands, newest first. */
export function recent(db: DatabaseSync, limit: number): ShellHistoryRow[] {
	return allRows<ShellHistoryRow>(
		db.prepare("SELECT cwd, command, count, last_at, last_exit FROM shell_history ORDER BY last_at DESC LIMIT ?"),
		limit,
	);
}

/** Keeps the `keep` most recently run commands and deletes the rest. */
export function prune(db: DatabaseSync, keep: number): void {
	db.prepare(
		"DELETE FROM shell_history WHERE rowid NOT IN (SELECT rowid FROM shell_history ORDER BY last_at DESC LIMIT ?)",
	).run(keep);
}
