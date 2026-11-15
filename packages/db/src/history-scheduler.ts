import { DAY_MS, HOUR_MS } from "../../common/src/time.ts";
import type { AgentDb } from "./db.ts";
import { DEFAULT_HISTORY_WINDOWS, type HistoryWindows } from "./history-archive.ts";
import { sharedDbWriter } from "./writer/client.ts";

/** Next housekeeping time and at most one admitted pass per database in this process. */
const due = new Map<string, number>();
const running = new Set<string>();

/**
 * Schedules at most one daily history pass on the database's bounded writer. Compression, archive reads and SQLite
 * run there; unavailable workers never fall back to the calling thread. Busy, locked or failed passes retry in an
 * hour. The global windows are read when the pass is admitted; errors never reach the foreground caller.
 */
export function scheduleHistoryArchive(
	agentDb: () => AgentDb,
	windows: HistoryWindows | (() => HistoryWindows) = DEFAULT_HISTORY_WINDOWS,
	now: () => number = Date.now,
): void {
	let target: AgentDb;
	try {
		target = agentDb();
	} catch {
		return;
	}
	const file = target.file;
	const at = now();
	if (running.has(file) || (due.get(file) ?? 0) > at) return;
	due.set(file, at + DAY_MS);
	running.add(file);
	const run = async () => {
		try {
			if (!target.db.isOpen) {
				due.delete(file);
				return;
			}
			const writer = sharedDbWriter({
				file,
				mirrorFile: target.mirrorFile,
				archiveDir: target.archiveDir,
				privateParent: false,
			});
			if ((await writer.archive(now(), typeof windows === "function" ? windows() : windows)).skipped)
				due.set(file, now() + HOUR_MS);
		} catch {
			// A failed archive leaves its source rows in place; a committed archive can safely be retried.
			due.set(file, now() + HOUR_MS);
		} finally {
			running.delete(file);
		}
	};
	setImmediate(() => void run()).unref();
}
