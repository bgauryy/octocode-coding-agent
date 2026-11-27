import type { MachineProcess } from "../../../../db/src/api.ts";
import { isProcessTitle } from "../shared/process-title.ts";
import { isTableNoise, type PsSnapshot, readPsSnapshot } from "../shared/ps-snapshot.ts";

/** One process of the shared process table with the figures the busiest list ranks by. */
export interface CpuRow {
	pid: number;
	ppid: number;
	/** Percent of one core. */
	cpu: number;
	rssKb: number;
	command: string;
}

/** The program's name: an Octocode title whole, else the last path segment of the first word, at most 60 characters. */
function shortCommand(command: string): string {
	if (isProcessTitle(command)) return command.split(/\s/)[0];
	const first = command.split(/\s/)[0] ?? command;
	return (first.split("/").pop() || first).slice(0, 60);
}

/** The Octocode process `pid` is or runs under: the nearest one up its parent chain whose command is a process title. */
function ownerOf(pid: number, byPid: ReadonlyMap<number, CpuRow>): string | null {
	const seen = new Set<number>();
	for (let row = byPid.get(pid); row && !seen.has(row.pid); row = byPid.get(row.ppid)) {
		if (isProcessTitle(row.command)) return row.command.split(/\s/)[0];
		seen.add(row.pid);
	}
	return null;
}

/**
 * The `limit` processes using the most CPU plus the `limit` holding the most memory (one entry each), most CPU first,
 * each with the Octocode process that owns it: what a rule needs to name the cause and wake its owner.
 */
export function busiest(rows: readonly CpuRow[], limit: number): MachineProcess[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const picked = new Map<number, CpuRow>();
	for (const row of [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, limit)) picked.set(row.pid, row);
	for (const row of [...rows].sort((a, b) => b.rssKb - a.rssKb).slice(0, limit)) picked.set(row.pid, row);
	return [...picked.values()]
		.sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
		.map((row) => ({
			pid: row.pid,
			ppid: row.ppid,
			command: shortCommand(row.command),
			cpu: row.cpu,
			rss: row.rssKb * 1024,
			owner: ownerOf(row.pid, byPid),
		}));
}

/** The busiest processes of the shared process table, or none where there is no `ps` (Windows). */
export async function readBusiest(
	limit: number,
	table: () => Promise<PsSnapshot | undefined> = readPsSnapshot,
): Promise<MachineProcess[]> {
	const snapshot = await table();
	if (!snapshot) return [];
	const rows: CpuRow[] = [];
	for (const row of snapshot.rows.values()) {
		if (isTableNoise(row)) continue;
		rows.push({ pid: row.pid, ppid: row.ppid, cpu: row.cpu, rssKb: row.rssKb, command: row.command });
	}
	return busiest(rows, limit);
}
