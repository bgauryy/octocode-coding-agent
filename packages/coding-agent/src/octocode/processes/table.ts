import { isTableNoise, type PsSnapshot, readPsSnapshot } from "../shared/ps-snapshot.ts";

/** One row of the operating system's process table. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Resident set size in KiB, as `ps` prints it. */
	rssKb: number;
	/** Start time as `processStartTime` writes it: whole seconds since the epoch, a decimal string. */
	started: string;
	command: string;
}

/**
 * The process table, or undefined where it cannot be read (Windows, no `ps`). This is the one boundary to the operating
 * system that classification reads: tests pass their own.
 */
export type ProcessTableSource = () => Promise<ProcessRow[] | undefined>;

/**
 * The process rows classification reads (from the shared `readPsSnapshot`), or undefined where the table cannot be read
 * (Windows, no `ps`, a timeout): callers show the process list as unavailable. Tests pass their own `ProcessTableSource`.
 */
export const readProcessTable: ProcessTableSource = async () => {
	let snapshot: PsSnapshot | undefined;
	try {
		snapshot = await readPsSnapshot();
	} catch {
		return undefined;
	}
	if (!snapshot) return undefined;
	const rows: ProcessRow[] = [];
	for (const row of snapshot.rows.values()) {
		if (row.started === undefined || isTableNoise(row)) continue;
		rows.push({ pid: row.pid, ppid: row.ppid, rssKb: row.rssKb, started: row.started, command: row.command });
	}
	return rows;
};
