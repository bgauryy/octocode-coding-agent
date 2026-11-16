import { type Db, isBusy, type OwnedChild, processSamples, withoutWaiting } from "../../../../db/src/api.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@octocodeai/octocode-common/time";
import { isProcessTitle } from "./title.ts";
import type { ProcessRow, ProcessTableSource } from "./table.ts";

/**
 * Each Octocode process records a memory sample (`rss`, `heapUsed`, pid, title, session or agent id, time) and the child
 * processes it owns every few minutes, in the agent database (`processSamples`). `/processes` reads them from every
 * process: growth comes from one process's series, and the child list is how another session finds what an Octocode
 * that crashed left behind.
 */

export const DEFAULT_SAMPLE_MINUTES = 5;
/** Samples older than this are deleted by the next sample that finds them (at most once an hour per process). */
export const SAMPLE_RETENTION_MS = 7 * DAY_MS;
const PRUNE_EVERY_MS = HOUR_MS;
const SAMPLE_MINUTES_ENV = "OCTOCODE_PROCESS_SAMPLE_MINUTES";
const MAX_INTERVAL_MS = 2_147_483_647;

function boundedIntervalMs(interval: number): number {
	return Math.max(1, Math.min(interval, MAX_INTERVAL_MS));
}

/** Milliseconds between samples from `OCTOCODE_PROCESS_SAMPLE_MINUTES` (default 5; 0 turns the periodic sample off; a value that is not a non-negative number is ignored). */
export function sampleIntervalMs(env: NodeJS.ProcessEnv): number {
	const raw = env[SAMPLE_MINUTES_ENV]?.trim();
	const minutes = raw ? Number(raw) : DEFAULT_SAMPLE_MINUTES;
	if (minutes === 0) return 0;
	return Number.isFinite(minutes) && minutes > 0
		? boundedIntervalMs(minutes * MINUTE_MS)
		: DEFAULT_SAMPLE_MINUTES * MINUTE_MS;
}

export interface SampleIdentity {
	role: string;
	id: string;
	title: string;
	sessionId: string | null;
	agentId: string | null;
	ownerPid: number | null;
	ownerStarted: string | null;
}

/**
 * The processes below `root` this Octocode owns: its MCP servers, bash jobs and whatever they started, but not another
 * Octocode process (a subagent) or its tree, which that process records itself. `kinds` names a direct child by pid (an
 * MCP server, a bash job); the processes below inherit its kind.
 */
function ownedChildren(table: readonly ProcessRow[], root: number, kinds: ReadonlyMap<number, string>): OwnedChild[] {
	const below = new Map<number, ProcessRow[]>();
	for (const row of table) {
		const siblings = below.get(row.ppid);
		if (siblings) siblings.push(row);
		else below.set(row.ppid, [row]);
	}
	const found: OwnedChild[] = [];
	const visited = new Set([root]);
	const pending = [{ rows: below.get(root) ?? [], index: 0, kind: "child" }];
	while (pending.length > 0) {
		const frame = pending[pending.length - 1];
		const row = frame.rows[frame.index++];
		if (!row) {
			pending.pop();
			continue;
		}
		if (visited.has(row.pid) || isProcessTitle(row.command)) continue;
		visited.add(row.pid);
		const kind = kinds.get(row.pid) ?? frame.kind;
		found.push({
			pid: row.pid,
			started: row.started,
			ppid: row.ppid,
			kind,
			label: row.command.length > 100 ? `${row.command.slice(0, 99)}…` : row.command,
			rss: row.rssKb * 1024,
		});
		const children = below.get(row.pid);
		if (children) pending.push({ rows: children, index: 0, kind });
	}
	return found;
}

export interface SamplerOptions {
	db: Db;
	table: ProcessTableSource;
	identity: () => SampleIdentity;
	/** Direct children by pid: `mcp`, `bash`. */
	kinds: () => ReadonlyMap<number, string>;
	intervalMs: number;
	selfPid?: number;
	started?: string | null;
	ppid?: number;
	memory?: () => { rss: number; heapUsed: number };
	now?: () => number;
	/** A failed sample must not break the session: the caller decides what to do with the error. */
	onError: (error: unknown) => void;
}

export interface ProcessSampler {
	/**
	 * Clears the timer and records the final sample (`ended`) at once, with the children of the last table read: a process
	 * that shuts down never waits for a `ps`. A table read still running is dropped, so the final sample stays the last.
	 */
	stop(): void;
	/** Settles when no table read is running: what a test awaits before reading the samples. */
	idle(): Promise<void>;
}

/**
 * Records a first sample and one every `intervalMs` (0: only the first and the final one). Nothing here is awaited by the
 * caller: the first sample's `ps` runs while the session starts. The timer never keeps the process alive.
 */
export function startProcessSampler(options: SamplerOptions): ProcessSampler {
	const now = options.now ?? Date.now;
	const selfPid = options.selfPid ?? process.pid;
	let lastPrune = 0;
	let queue: Promise<void> = Promise.resolve();
	let sampling = false;
	let stopped = false;
	/** The last process table read; undefined until the first read ends (or where none can be read). */
	let lastTable: ProcessRow[] | undefined;
	const record = (ended: boolean): void => {
		try {
			const memory = options.memory ? options.memory() : process.memoryUsage();
			const identity = options.identity();
			const at = now();
			// The last sample of a process that is ending may wait for the database; a periodic one never does.
			const write = <T>(run: () => T): T => (ended ? run() : withoutWaiting(options.db, run));
			const sample = {
				at,
				pid: selfPid,
				started: options.started ?? null,
				ppid: options.ppid ?? process.ppid,
				...identity,
				rss: memory.rss,
				heapUsed: memory.heapUsed,
				ended,
				children: lastTable ? ownedChildren(lastTable, selfPid, options.kinds()) : [],
			};
			write(() => processSamples.record(options.db, sample));
			if (at - lastPrune >= PRUNE_EVERY_MS) {
				write(() => processSamples.pruneBefore(options.db, at - SAMPLE_RETENTION_MS));
				lastPrune = at;
			}
		} catch (error) {
			// Another process holds the database: this sample is skipped, the next one is minutes away.
			if (!isBusy(error)) options.onError(error);
		}
	};
	const sampleOnce = async (): Promise<void> => {
		if (stopped) return;
		let table: ProcessRow[] | undefined;
		try {
			table = await options.table();
		} catch (error) {
			if (!stopped) options.onError(error);
			return;
		}
		// Stopped while `ps` ran: the final sample is already written and must stay the newest.
		if (stopped) return;
		lastTable = table;
		record(false);
	};
	const sample = () => {
		if (stopped || sampling) return;
		sampling = true;
		queue = queue.then(sampleOnce).finally(() => {
			sampling = false;
		});
	};
	sample();
	const timer = options.intervalMs > 0 ? setInterval(sample, boundedIntervalMs(options.intervalMs)) : undefined;
	timer?.unref();
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (timer) clearInterval(timer);
			record(true);
		},
		idle: () => queue,
	};
}
