import type { MachineProcess } from "../../../../db/src/api.ts";
import { isProcessTitle } from "../processes/title.ts";
import { type CommandRunner, runCommand } from "./readers.ts";

/** One row of `ps -A -o pid=,ppid=,%cpu=,rss=,command=`. */
export interface CpuRow {
	pid: number;
	ppid: number;
	/** Percent of one core. */
	cpu: number;
	rssKb: number;
	command: string;
}

const ROW = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
const PS_FIELDS = "pid=,ppid=,%cpu=,rss=,command=";

/** Parses `ps -A -o pid=,ppid=,%cpu=,rss=,command=`; lines that do not parse are dropped. */
export function parseCpuTable(text: string): CpuRow[] {
	const rows: CpuRow[] = [];
	for (const line of text.split("\n")) {
		const match = ROW.exec(line);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			cpu: Number(match[3]),
			rssKb: Number(match[4]),
			command: match[5].trim(),
		});
	}
	return rows;
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

/** The busiest processes from `ps`, or none where there is no `ps` (Windows). */
export async function readBusiest(limit: number, run: CommandRunner = runCommand): Promise<MachineProcess[]> {
	if (process.platform === "win32") return [];
	const text = await run("ps", ["-A", "-o", PS_FIELDS]);
	if (text === undefined) return [];
	// Not of interest: the `ps` that read the table, and exited children not yet reaped.
	const rows = parseCpuTable(text).filter(
		(row) => !row.command.startsWith(`ps -A -o ${PS_FIELDS}`) && !row.command.includes("<defunct>"),
	);
	return busiest(rows, limit);
}
