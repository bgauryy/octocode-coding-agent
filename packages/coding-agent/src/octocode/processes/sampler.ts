import { type Db, type OwnedChild, processSamples } from "../../../../db/src/api.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../../common/src/time.ts";
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

/** Milliseconds between samples from `OCTOCODE_PROCESS_SAMPLE_MINUTES` (default 5; 0 turns the periodic sample off; a value that is not a non-negative number is ignored). */
export function sampleIntervalMs(env: NodeJS.ProcessEnv): number {
	const raw = env[SAMPLE_MINUTES_ENV]?.trim();
	const minutes = raw ? Number(raw) : DEFAULT_SAMPLE_MINUTES;
	return Number.isFinite(minutes) && minutes >= 0 ? minutes * MINUTE_MS : DEFAULT_SAMPLE_MINUTES * MINUTE_MS;
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
	for (const row of table) below.set(row.ppid, [...(below.get(row.ppid) ?? []), row]);
	const found: OwnedChild[] = [];
	const walk = (parent: number, inherited: string) => {
		for (const row of below.get(parent) ?? []) {
			if (isProcessTitle(row.command)) continue;
			const kind = kinds.get(row.pid) ?? inherited;
			found.push({
				pid: row.pid,
				started: row.started,
				ppid: row.ppid,
				kind,
				label: row.command.length > 100 ? `${row.command.slice(0, 99)}…` : row.command,
				rss: row.rssKb * 1024,
			});
			walk(row.pid, kind);
		}
	};
	walk(root, "child");
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
	/** Clears the timer and records the final sample (`ended`). */
	stop(): Promise<void>;
}

/** Records a first sample now and one every `intervalMs` (0: only the first and the final one). The timer never keeps the process alive. */
export async function startProcessSampler(options: SamplerOptions): Promise<ProcessSampler> {
	const now = options.now ?? Date.now;
	const selfPid = options.selfPid ?? process.pid;
	let lastPrune = 0;
	let queue: Promise<void> = Promise.resolve();
	const sampleOnce = async (ended: boolean): Promise<void> => {
		try {
			const table = await options.table();
			const memory = options.memory ? options.memory() : process.memoryUsage();
			const identity = options.identity();
			const at = now();
			processSamples.record(options.db, {
				at,
				pid: selfPid,
				started: options.started ?? null,
				ppid: options.ppid ?? process.ppid,
				...identity,
				rss: memory.rss,
				heapUsed: memory.heapUsed,
				ended,
				children: table ? ownedChildren(table, selfPid, options.kinds()) : [],
			});
			if (at - lastPrune >= PRUNE_EVERY_MS) {
				lastPrune = at;
				processSamples.pruneBefore(options.db, at - SAMPLE_RETENTION_MS);
			}
		} catch (error) {
			options.onError(error);
		}
	};
	const sample = (ended: boolean): Promise<void> => {
		queue = queue.then(() => sampleOnce(ended));
		return queue;
	};
	await sample(false);
	const timer = options.intervalMs > 0 ? setInterval(() => void sample(false), options.intervalMs) : undefined;
	timer?.unref();
	return {
		async stop() {
			if (timer) clearInterval(timer);
			await sample(true);
		},
	};
}
