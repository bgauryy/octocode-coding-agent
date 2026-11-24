import { execFile } from "node:child_process";
import { PS_UTC_ENV, utcSeconds } from "@octocodeai/octocode-common/process-start";

/** One process as the single `ps -A` lists it; `started` is whole seconds since the epoch, undefined when `ps` printed none. */
export interface PsRow {
	pid: number;
	ppid: number;
	pgid: number;
	/** `ps` state: a zombie (`Z…`) has exited already. */
	stat: string;
	/** Percent of one core. */
	cpu: number;
	/** Resident set size in KiB. */
	rssKb: number;
	started: string | undefined;
	command: string;
}

/** The process table of one read: `at` is `Date.now()` when `ps` started, so every process it lists started at or before it. */
export interface PsSnapshot {
	at: number;
	rows: ReadonlyMap<number, PsRow>;
}

/** The one `ps` this app runs for the whole table: every caller's columns, so one read answers all of them. */
const PS_FIELDS = "pid=,ppid=,pgid=,stat=,%cpu=,rss=,lstart=,command=";
const PS_COMMAND = `ps -A -o ${PS_FIELDS}`;
/** A read is shared for this long after it finishes; a new one starts only after it. */
export const PS_CACHE_MS = 1000;
/** `ps` bound: a hung `ps` must not leave a sweep waiting forever. */
export const PS_TIMEOUT_MS = 2000;

const ROW =
	/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)(?:\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})(?:\s+(.*))?)?\s*$/;

/**
 * Parses the output of the one `ps` (printed in UTC). A row `ps` printed without a start time stays listed (started
 * undefined): dropping it would read as "gone". Lines that do not parse are dropped.
 */
export function parsePsTable(text: string): Map<number, PsRow> {
	const rows = new Map<number, PsRow>();
	for (const line of text.split("\n")) {
		const match = ROW.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		rows.set(pid, {
			pid,
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			stat: match[4],
			cpu: Number(match[5]),
			rssKb: Number(match[6]),
			started: match[7] === undefined ? undefined : utcSeconds(match[7]),
			command: (match[8] ?? "").trim(),
		});
	}
	return rows;
}

/** Not processes of interest: the `ps` that just read the table, and exited children not yet reaped. */
export const isTableNoise = (row: PsRow): boolean =>
	row.command.startsWith(PS_COMMAND) || row.command.includes("<defunct>");

function spawnPs(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"ps",
			["-A", "-o", PS_FIELDS],
			{ encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: PS_UTC_ENV() },
			(error, stdout) => (error ? reject(new Error(`ps failed: ${error.message}`, { cause: error })) : resolve(stdout)),
		);
	});
}

let cached: { snapshot: PsSnapshot; doneAt: number } | undefined;
let loading: { at: number; read: Promise<PsSnapshot> } | undefined;

function startRead(): { at: number; read: Promise<PsSnapshot> } {
	const at = Date.now();
	const entry = { at, read: undefined as unknown as Promise<PsSnapshot> };
	entry.read = (async () => {
		try {
			const snapshot = { at, rows: parsePsTable(await spawnPs()) };
			cached = { snapshot, doneAt: Date.now() };
			return snapshot;
		} finally {
			if (loading === entry) loading = undefined;
		}
	})();
	return entry;
}

/** `fresh`: the table must have been read after this call (a decision to signal, or to find a process just started). */
export interface PsReadOptions {
	fresh?: boolean;
}

/**
 * The process table, the only place `ps` is spawned for it. A read is reused for `PS_CACHE_MS` after it finished, and
 * callers that ask while one runs share it (one snapshot is kept, so memory is bounded). A `fresh` caller takes only a
 * read that started after it asked, so a process it just spawned is listed. Undefined on Windows. A failed read (no
 * `ps`, a timeout) rejects for every waiter and is not kept: the next caller reads again.
 */
export function readPsSnapshot(options: PsReadOptions = {}): Promise<PsSnapshot | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	const asked = Date.now();
	const usable = (at: number) => !options.fresh || at >= asked;
	if (cached && usable(cached.snapshot.at) && asked - cached.doneAt < PS_CACHE_MS)
		return Promise.resolve(cached.snapshot);
	if (!loading || !usable(loading.at)) loading = startRead();
	return loading.read;
}

/** Tests: forget the kept snapshot. */
export function resetPsSnapshot(): void {
	cached = undefined;
	loading = undefined;
}
