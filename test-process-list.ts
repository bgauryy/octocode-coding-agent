import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

/** A ps snapshot is unbounded. Discard an oversized or incomplete row without using its partial evidence. */
export async function readProcessRows(chunks: AsyncIterable<Buffer>, visit: (row: string) => void): Promise<void> {
	const maxRowBytes = 8 * 1024 * 1024;
	let pending = Buffer.alloc(0);
	let length = 0;
	for await (const chunk of chunks) {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			const piece = chunk.subarray(start, end);
			if (length + piece.length <= maxRowBytes) {
				if (length === 0 && newline >= 0) visit(piece.toString("utf8"));
				else {
					if (pending.length === 0) pending = Buffer.allocUnsafe(maxRowBytes);
					piece.copy(pending, length);
					if (newline >= 0) visit(pending.toString("utf8", 0, length + piece.length));
				}
			}
			length += piece.length;
			if (newline < 0) break;
			length = 0;
			start = newline + 1;
		}
	}
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	started: string;
	command: string;
}

/** The stable locale and time zone make start stamps comparable across the marked and unmarked snapshots. */
export function processRow(line: string): ProcessRow | undefined {
	const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
	if (!match) return undefined;
	const [, pid, ppid, pgid, started, command] = match;
	if (
		Number(pid) <= 1 ||
		![pid, ppid, pgid].every((id) => Number.isSafeInteger(Number(id)) && Number(id) <= 0x7fffffff)
	)
		return undefined;
	return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started, command };
}

/** Read ps with pipes. Its stdout and stderr can contain secrets and are never copied into diagnostics. */
export async function visitProcesses(
	withEnvironment: boolean,
	visit: (row: ProcessRow) => void,
	pids?: readonly number[],
): Promise<void> {
	const fields = "pid=,ppid=,pgid=,lstart=,command=";
	const flags = withEnvironment ? "eww" : "ww";
	const run = async (args: string[], selected?: ReadonlySet<number>) => {
		const ps = spawn("ps", args, {
			env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		const closed = new Promise<number | null>((resolve, reject) => {
			ps.once("error", reject);
			ps.once("close", resolve);
		});
		const rows = readProcessRows(ps.stdout, (line) => {
			const row = processRow(line);
			if (row && (!selected || selected.has(row.pid))) visit(row);
		}).catch((error) => {
			ps.kill();
			throw error;
		});
		const [status] = await Promise.all([closed, rows]);
		// ps returns 1 when every selected process exited before the read.
		if (status !== 0 && !(pids !== undefined && status === 1))
			throw new Error(`ps process scan exited with status ${status}.`);
	};
	if (pids === undefined) await run([`ax${flags}`, "-o", fields]);
	else
		for (let i = 0; i < pids.length; i += 128) {
			const batch = pids.slice(i, i + 128);
			await run([flags, "-p", batch.join(","), "-o", fields], new Set(batch));
		}
}
