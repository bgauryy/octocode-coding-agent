import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { splitEvidence } from "./backlog-evidence.ts";
import { addLink, evidenceRows, setEvidence } from "./queries/backlog.ts";
import { snapshot } from "./queries/maintenance.ts";
import { addColumn, addMissingColumns, WORKSPACE_DB_KEY_COLUMN } from "./schema-columns.ts";
import { upgradeWorkspaceEventKeys } from "./schema-events.ts";
import { ENSURED_OBJECTS } from "./schema-sql.ts";

/**
 * One upgrade step: brings a file at schema version `from` to `from + 1`. It runs inside the upgrade's single write
 * transaction with the steps after it, so a failure leaves the file at the version it had.
 */
export interface Migration {
	from: number;
	/**
	 * Whether an older reader can no longer use the file afterwards (a dropped or renamed object, a changed meaning).
	 * A step that only adds tables, columns, indexes or rows is not breaking.
	 */
	breaking: boolean;
	run(db: DatabaseSync): void;
}

/**
 * The steps from `version` to `target` in order, or undefined when one is missing (that file cannot be upgraded).
 * Downgrades do not exist: a `version` at or above `target` has no chain.
 */
export function migrationChain(
	migrations: readonly Migration[],
	version: number,
	target: number,
): Migration[] | undefined {
	if (version >= target) return undefined;
	const chain: Migration[] = [];
	for (let from = version; from < target; from++) {
		const step = migrations.find((migration) => migration.from === from);
		if (!step) return undefined;
		chain.push(step);
	}
	return chain;
}

/** The oldest reader a file keeps after `steps` run: `stored`, raised to the `to` version of the last breaking step. */
export function minReaderAfter(stored: number, steps: readonly Migration[]): number {
	return steps.reduce((oldest, step) => (step.breaking ? Math.max(oldest, step.from + 1) : oldest), stored);
}

/** Where the copy of a file taken before upgrading it from `version` lives: beside it, one per from-version. */
const backupPath = (file: string, version: number): string => `${file}.v${version}.bak`;

/** The newest backup beside `file` taken before an upgrade from a version below `below`, if one exists. */
export function newestBackup(file: string, below: number): string | undefined {
	const base = path.basename(file);
	let best: { version: number; name: string } | undefined;
	for (const name of fs.readdirSync(path.dirname(file))) {
		const match = name.startsWith(`${base}.v`) ? /^\.v(\d+)\.bak$/.exec(name.slice(base.length)) : null;
		const version = match ? Number(match[1]) : -1;
		if (version >= 0 && version < below && (!best || version > best.version)) best = { version, name };
	}
	return best && path.join(path.dirname(file), best.name);
}

/**
 * Copies the open file (`VACUUM INTO`, private to this user) to `backupPath(file, version)`, replacing an earlier copy
 * from the same version by an atomic rename. VACUUM cannot run inside the upgrade transaction, so another process may
 * upgrade the file between the version read and the copy; a copy that is no longer at `version` is discarded.
 */
export function backupBeforeUpgrade(db: DatabaseSync, file: string, version: number): void {
	const target = backupPath(file, version);
	const partial = `${target}.${process.pid}.tmp`;
	fs.rmSync(partial, { force: true });
	try {
		snapshot(db, partial);
		if (headerVersion(partial) === version) fs.renameSync(partial, target);
	} finally {
		fs.rmSync(partial, { force: true });
	}
}

/** `user_version` from a database file's header: the big-endian 32-bit integer at byte 60. */
function headerVersion(file: string): number {
	const header = Buffer.alloc(4);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, header, 0, 4, 60);
	} finally {
		fs.closeSync(fd);
	}
	return header.readInt32BE(0);
}

/** Moves path and URL references out of every item's evidence text into `evidence` links, after its existing links. */
function linkTextEvidence(db: DatabaseSync): void {
	for (const row of evidenceRows(db)) {
		const { text, links } = splitEvidence(row.evidence.split("\n"), row.workspace_id);
		if (!links.length) continue;
		for (const link of links) addLink(db, row.id, link.relation, JSON.stringify(link.target));
		setEvidence(db, row.id, text.join("\n"));
	}
}

/**
 * The coordination file's steps. Version 10 → 11 gives a version-10 file the objects and columns added while version 10
 * shipped (each only where missing, so a file that already has them is unchanged), the per-workspace event dedupe key,
 * and evidence links in place of path and URL evidence text. Version 11 → 12 adds the registry's workspace file key
 * column; it only adds, so older builds still read the file. Moving the rows out is not a schema step: the split
 * (`schema-split.ts`) runs at open and raises `min_reader` itself.
 */
export const COORDINATION_MIGRATIONS: readonly Migration[] = [
	{
		from: 10,
		breaking: false,
		run: (db) => {
			db.exec(ENSURED_OBJECTS);
			addMissingColumns(db);
			upgradeWorkspaceEventKeys(db);
			linkTextEvidence(db);
		},
	},
	{
		from: 11,
		breaking: false,
		run: (db) => addColumn(db, "workspaces", "db_key", WORKSPACE_DB_KEY_COLUMN),
	},
];
