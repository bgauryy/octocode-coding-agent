import fs from "node:fs";
import path from "node:path";
import { syncDirectorySync } from "../../common/src/atomic-file.ts";
import { snapshot } from "./queries/maintenance.ts";
import { loadSqlite } from "./sqlite.ts";

/**
 * The files the machine file's split (`schema-split.ts`) writes beside it: its backup, its copies in progress, and the
 * earlier files it moves out of their way. It deletes only its own leftovers; every other file it finds is kept.
 */

/** Where the copy of a machine file taken before its split lives; the copy before it is kept at `<path>.1`. */
export const splitBackupPath = (file: string): string => `${file}.pre-split.bak`;

/** The private file a split of this process fills before renaming it to `target`. */
export const partialOf = (target: string): string => `${target}.${process.pid}.tmp`;

/** A partial of any process, with its write-ahead files: `partialOf` names. */
const PARTIAL = /\.\d+\.tmp(-wal|-shm|-journal)?$/;

/**
 * Deletes the partial files a killed split left beside the machine file and in its workspace folder. Call it holding
 * the machine file's write lock: only a split writes them, and a split of another process waits for that lock.
 */
export function removeStalePartials(file: string, workspaceDir: string): void {
	const backup = path.basename(splitBackupPath(file));
	for (const [dir, owned] of [
		[path.dirname(file), (name: string) => name.startsWith(`${backup}.`)],
		[workspaceDir, (name: string) => name.includes(".db.")],
	] as const) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const name of names) if (owned(name) && PARTIAL.test(name)) fs.rmSync(path.join(dir, name), { force: true });
	}
}

/**
 * Copies the machine file at `file` as its committed state is now to `splitBackupPath`, through a connection of its
 * own (`VACUUM INTO` cannot run inside the split's transaction). The split calls it holding the write lock, so the copy
 * holds exactly the rows it moves. A backup already there (an earlier split's, before a rollback or a crash) is kept as
 * `<backup>.1`, replacing an older one.
 */
export function backupBeforeSplit(file: string): void {
	const target = splitBackupPath(file);
	const partial = partialOf(target);
	const { DatabaseSync } = loadSqlite();
	const reader = new DatabaseSync(file);
	try {
		reader.exec("PRAGMA busy_timeout=5000");
		fs.rmSync(partial, { force: true });
		snapshot(reader, partial);
		if (fs.existsSync(target)) fs.renameSync(target, `${target}.1`);
		fs.renameSync(partial, target);
		syncDirectorySync(path.dirname(target));
	} finally {
		reader.close();
		fs.rmSync(partial, { force: true });
	}
}

const SIDE_FILES = ["", "-wal", "-shm"];

/**
 * Moves a database file found at `target` (an earlier split's file left by a rollback or a crash) out of the way with
 * its write-ahead files, as `<target>.replaced-<n>`, the first free `n`; returns where it went. Never deletes it: it
 * may hold rows written after an earlier split.
 */
export function moveAside(target: string): string | undefined {
	if (!SIDE_FILES.some((suffix) => fs.existsSync(target + suffix))) return undefined;
	let n = 1;
	while (SIDE_FILES.some((suffix) => fs.existsSync(`${target}.replaced-${n}${suffix}`))) n += 1;
	const aside = `${target}.replaced-${n}`;
	for (const suffix of SIDE_FILES) if (fs.existsSync(target + suffix)) fs.renameSync(target + suffix, aside + suffix);
	return aside;
}
