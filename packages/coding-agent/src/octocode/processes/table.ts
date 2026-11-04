import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PS_UTC_ENV, utcSeconds } from "../shared/process.ts";

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

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

/** Parses `ps -A -o pid=,ppid=,rss=,lstart=,command=` printed in UTC; lines that do not parse are dropped. */
export function parseProcessTable(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const match = ROW.exec(line);
		const started = match ? utcSeconds(match[4]) : undefined;
		if (!match || started === undefined) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			rssKb: Number(match[3]),
			started,
			command: match[5].trim(),
		});
	}
	return rows;
}

const run = promisify(execFile);

export const readProcessTable: ProcessTableSource = async () => {
	if (process.platform === "win32") return undefined;
	try {
		const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,lstart=,command="], {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 64 * 1024 * 1024,
			env: PS_UTC_ENV(),
		});
		// Not processes of interest: the `ps` that just read the table, and exited children not yet reaped.
		return parseProcessTable(stdout).filter(
			(row) => !row.command.startsWith("ps -A -o pid=,ppid=,rss=,lstart=") && !row.command.includes("<defunct>"),
		);
	} catch {
		// No `ps`, or it timed out: callers show the process list as unavailable.
		return undefined;
	}
};
