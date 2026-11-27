import { psFieldsSync } from "@octocodeai/octocode-common/process-start";
import { keepOwnStart, keptOwnStart, ownStartAsync } from "@octocodeai/octocode-common/own-start";
import { validPid } from "../../utils/process-id.ts";
import { killWindowsTree, signalTree, taskkillTree } from "../../utils/process-tree.ts";
import {
	memoTable,
	type ProcessTable,
	type ProcessRow,
	PS_UTC_ENV,
	readProcessTable,
	refreshProcessTable,
	startSeconds,
	TABLE_TTL_MS,
	utcSeconds,
} from "./process-table.ts";
import { descendantRows } from "./process-descendants.ts";

// The tree primitives live in utils/ so core's shell can use them too; the hosted ACP workspace reaches them through
// this file, the one process module its host import baseline lists.
export { adoptTree, prepareTree, reapWithParent, signalTree } from "../../utils/process-tree.ts";

/** How long a stopped process tree gets after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;

/** Whether a process with this pid exists (EPERM: it exists but belongs to someone else). Non-positive or non-integer pids are not alive. */
export function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** This process's parent when the module loaded. */
const loadedPpid = process.ppid;

/**
 * Whether the process that started this one (`parentPid`) is gone: dead, or, when it spawned this process directly,
 * this process was reparented since it loaded (so a later process that got the parent's pid does not count as it). A
 * launcher in between can exit while the parent lives: then only the pid is checked. Windows never reparents.
 */
export function parentGone(parentPid: number): boolean {
	return (loadedPpid === parentPid && process.ppid !== loadedPpid) || !processAlive(parentPid);
}

/** Reads of other processes' start times in flight, shared by concurrent askers. This process's is `own-start.ts`'s. */
const starting = new Map<number, Promise<string | undefined>>();

export { PS_UTC_ENV, utcSeconds } from "./process-table.ts";

/** `ps -o lstart=` of one process on the calling thread (undefined: no `ps`, a timeout, or no such process). */
function psStart(pid: number, env: NodeJS.ProcessEnv): string | undefined {
	return psFieldsSync(pid, "lstart=", env)?.trim().replace(/\s+/g, " ") || undefined;
}

/** A pid `ps` can be asked about: POSIX, a positive integer. */
const askable = (pid: number): boolean => process.platform !== "win32" && Number.isInteger(pid) && pid > 0;

/**
 * When the process with this pid started, as whole seconds since the epoch in a decimal string (time-zone free, so
 * two Octocode processes in different zones agree), or undefined when unknown (Windows, no `ps`, no such process). A
 * pid alone proves nothing once the system reuses it; the pid plus this value names one process. One `ps` on the
 * calling thread: for this process (read once and kept) or a one-off; timers and exit paths use `processStartTimeAsync`.
 */
export function processStartTime(pid: number): string | undefined {
	if (!askable(pid)) return undefined;
	const kept = pid === process.pid ? keptOwnStart() : undefined;
	if (kept) return kept.started;
	const lstart = psStart(pid, PS_UTC_ENV());
	const started = lstart === undefined ? undefined : utcSeconds(lstart);
	if (pid === process.pid) keepOwnStart(started);
	return started;
}

/**
 * Starts reading this process's start time in the background, so the first `processStartTime(process.pid)` (a session
 * start records it) finds the value kept instead of running `ps` on the calling thread. The read is the one
 * `processStartTimeAsync` shares; it never rejects, and a caller that asks before it answers runs its own `ps`.
 */
export function warmProcessStartTime(): Promise<string | undefined> {
	return processStartTimeAsync(process.pid);
}

/** `processStartTime` without blocking: one asynchronous `ps` (this process's own value is read once and kept). */
export async function processStartTimeAsync(pid: number): Promise<string | undefined> {
	if (!askable(pid)) return undefined;
	if (pid === process.pid) return ownStartAsync();
	let pending = starting.get(pid);
	if (!pending) {
		pending = readProcessTable({ fresh: true })
			.then((table) => table?.rows.get(pid)?.started)
			.finally(() => starting.delete(pid));
		starting.set(pid, pending);
	}
	return pending;
}

/** How a table read after `started` judges `pid`: `same`, `other` (gone or reused), `unknown` (the table cannot tell). */
function judge(table: ProcessTable | undefined, pid: number, started: string): "same" | "other" | "unknown" {
	const seconds = startSeconds(started);
	if (!table || seconds === undefined) return "unknown";
	const row = table.rows.get(pid);
	if (row?.started !== undefined && Number(row.started) === seconds) return "same";
	// A table read before the recorded process started (`ps` prints whole seconds) says nothing else about it.
	if (table.at < (seconds + 1) * 1000) return "unknown";
	if (!row) return "other";
	return row.started === undefined ? "unknown" : "other";
}

/**
 * How `pid` compares with the process that recorded `started`: `same` (alive, same start time), `other` (gone, or a
 * later process that got the pid) or `unknown` (alive, but no start time was recorded or `ps` could not read one).
 * Compares afresh (one asynchronous `ps -A`): for a decision to signal, where unknown is not a match. Values recorded
 * before start times were time-zone free (`Mon Jan  2 15:04:05 2006`) are compared in this zone.
 */
export async function processMatch(
	pid: unknown,
	started: string | null | undefined,
): Promise<"same" | "other" | "unknown"> {
	if (!processAlive(pid)) return "other";
	if (!started) return "unknown";
	const table = await readProcessTable({ fresh: true });
	if (!table) return "unknown";
	// Still alive after the read: the table's row is this process's, not one that died meanwhile.
	return processAlive(pid) ? judge(table, pid as number, started) : "other";
}

/**
 * How long a start-time verdict is reused, and how old the shared process table (`process-table.ts`) may be before a
 * liveness question asks for a new one: sweeps, `list`, `send` and lease checks ask about the same few processes
 * often, and a pid reused inside this window is retired by the next sweep after it.
 */
export const VERDICT_TTL_MS = TABLE_TTL_MS;
const VERDICT_LIMIT = 256;
const verdicts = new Map<string, { at: number; match: "same" | "other" | "unknown" }>();

/** A verdict the shared table or an earlier comparison gives without running `ps`; undefined when neither can tell. */
function knownVerdict(pid: number, started: string, now: number): "same" | "other" | "unknown" | undefined {
	// This process's identity cannot change during its lifetime; registration may already have captured it.
	const self = pid === process.pid ? keptOwnStart()?.started : undefined;
	const seconds = self === undefined ? undefined : startSeconds(started);
	if (seconds !== undefined) return Number(self) === seconds ? "same" : "other";
	const table = memoTable();
	const fromTable = judge(table, pid, started);
	// A table cannot be wrong about `other`: a pid names one process at a time, so a later read cannot undo it.
	if (fromTable === "other" || (fromTable === "same" && table && now - table.at < VERDICT_TTL_MS)) return fromTable;
	const remembered = verdicts.get(`${pid} ${started}`);
	if (remembered && now - remembered.at < VERDICT_TTL_MS) return remembered.match;
	return undefined;
}

/** The start-time comparison of a live `pid` against a recorded `started`: one `ps` on the calling thread. */
function compareStart(pid: number, started: string): "same" | "other" | "unknown" {
	const now = /^\d+$/.test(started) ? processStartTime(pid) : psStart(pid, { ...process.env, LC_ALL: "C" });
	return now === undefined ? "unknown" : now === started ? "same" : "other";
}

/**
 * Whether `pid` may still be the process that recorded `started` (its `processStartTime`): alive, and not a later
 * process that got the pid. Lenient, for liveness: without a recorded or readable start time it is just `processAlive`
 * (an owner that cannot be judged keeps what it owns). Every caller shares one memo: the shared process table and the
 * comparisons made here answer for `VERDICT_TTL_MS` after `now` (ms), while a dead pid is seen at once (`kill -0`
 * needs no `ps`). When neither can tell, one `ps` runs on the calling thread: for a one-off question (a start, a
 * command). Timers use `liveProcess`, which never does. Before signalling a process use `processMatch`.
 */
export function sameProcess(pid: unknown, started: string | null | undefined, now = Date.now()): boolean {
	if (!processAlive(pid)) return false;
	if (!started) return true;
	const known = knownVerdict(pid as number, started, now);
	if (known) return known !== "other";
	const key = `${pid as number} ${started}`;
	const verdict = { at: now, match: compareStart(pid as number, started) };
	verdicts.delete(key);
	verdicts.set(key, verdict);
	if (verdicts.size > VERDICT_LIMIT) verdicts.delete(verdicts.keys().next().value!);
	return verdict.match !== "other";
}

/** Await a shared process-table refresh when needed, without blocking input. Unknown owners keep their resources. */
export async function sameProcessAsync(pid: unknown, started: string | null | undefined): Promise<boolean> {
	if (!processAlive(pid)) return false;
	if (!started || process.platform === "win32") return true;
	const known = knownVerdict(pid as number, started, Date.now());
	if (known && known !== "unknown") return known !== "other";
	const table = await refreshProcessTable();
	return processAlive(pid) && judge(table, pid as number, started) !== "other";
}

/**
 * `sameProcess` for a timer (the team's ticker and sweep): never runs `ps` on the calling thread. It answers from the
 * shared table (one asynchronous `ps -A` for every caller, `refreshProcessTable`) and asks for a new table when that
 * one is older than `VERDICT_TTL_MS` at `now` or cannot tell (a process that started after it). Until the new table
 * arrives such a process counts as alive, as one whose start cannot be read does. With `refresh` false it only reads
 * what is known: for a row whose fresh heartbeat already vouches for its process.
 */
export function liveProcess(
	pid: unknown,
	started: string | null | undefined,
	now = Date.now(),
	refresh = true,
): boolean {
	if (!processAlive(pid)) return false;
	if (!started || process.platform === "win32") return true;
	const known = knownVerdict(pid as number, started, now);
	if ((!known || known === "unknown") && refresh) void refreshProcessTable();
	return known !== "other";
}

/**
 * Start times (`processStartTime` values) of the live members of the process group `pgid` (POSIX, from the shared
 * process table), or undefined when `ps` fails or a member's start cannot be read: unknown is not the same as no
 * member. A zombie has exited already and is left out.
 */
export async function groupStartTimes(pgid: number): Promise<Array<{ pid: number; started: string }> | undefined> {
	if (!validPid(pgid) || process.platform === "win32") return undefined;
	const table = await readProcessTable({ fresh: true });
	if (table === undefined) return undefined;
	const members: Array<{ pid: number; started: string }> = [];
	for (const row of table.rows.values()) {
		if (row.pgid !== pgid || row.stat.startsWith("Z")) continue;
		if (row.started === undefined) return undefined;
		members.push({ pid: row.pid, started: row.started });
	}
	return members;
}

/**
 * Whether any process of the group led by `pid` is alive (POSIX; spawn it with `detached: true`). A shell that exits
 * can leave children (`server &`, `nohup`) in its group. Windows has no groups: the process itself.
 */
export function groupAlive(pid: number | undefined): boolean {
	if (!validPid(pid)) return false;
	if (process.platform === "win32") return processAlive(pid);
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The live members of the process group `pgid` (POSIX, from the shared process table), each with its command line. Empty on
 * Windows (no groups) or when `ps` fails.
 */
export async function groupMembers(pgid: number | undefined): Promise<Array<{ pid: number; command: string }>> {
	if (!validPid(pgid) || process.platform === "win32") return [];
	const table = await readProcessTable({ fresh: true });
	return [...(table?.rows.values() ?? [])]
		.filter((row) => row.pgid === pgid && !row.stat.startsWith("Z"))
		.map((row) => ({ pid: row.pid, command: row.command }));
}

/** How often `stopTree` checks whether the tree is gone. */
const STOP_POLL_MS = 25;

/**
 * Pids of every descendant of `pid` (POSIX, one asynchronous `ps -A`), including ones that left its process group: a
 * detached Chrome or a background bash job leads a group of its own, so a group signal misses it. Empty on Windows (a
 * job or taskkill /T ends the whole tree) or when `ps` fails.
 */
export async function descendantPids(pid: number | undefined): Promise<number[]> {
	return (await descendantRows(pid)).map((row) => row.pid);
}

/** The tree rooted at `pid`, as taken when the stop began: its group plus every descendant seen then. */
function treeAlive(pid: number, descendants: readonly number[]): boolean {
	return groupAlive(pid) || descendants.some((each) => processAlive(each));
}

/** SIGKILL to the group and to each listed descendant still alive (with its own group, when it leads one). */
function killRest(pid: number, descendants: readonly number[]): void {
	if (groupAlive(pid)) signalTree(pid, "SIGKILL");
	for (const each of descendants) if (processAlive(each)) signalTree(each, "SIGKILL");
}

/**
 * SIGTERM to the tree, then SIGKILL to whatever is left after `graceMs`; resolves once the group is gone (a killed
 * leader stays a zombie until Node reaps it) or another `graceMs` passed. For shutdown, where the unref'd timer of
 * `killTree` would never fire because the process exits first.
 * `retained` names descendants seen before graceful RPC shutdown; every captured start time is checked before escalation.
 */
export async function stopTree(
	pid: number | undefined,
	graceMs = KILL_GRACE_MS,
	retained: readonly ProcessRow[] = [],
): Promise<void> {
	if (!validPid(pid)) return;
	// Taken before the signal: once the root exits, its detached descendants belong to init and no longer show as its.
	const family = await descendantRows(pid, true);
	const identities = new Map([...family, ...retained].map((row) => [row.pid, row]));
	const descendants = [...identities.keys()].filter((each) => each !== pid);
	const settle = async (ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (treeAlive(pid, descendants) && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
	};
	if (process.platform === "win32") {
		// No signals: the job (or taskkill) ends the tree at once, also after the root exited.
		await killWindowsTree(pid);
		await settle(graceMs);
		if (treeAlive(pid, descendants)) {
			taskkillTree(pid);
			await settle(graceMs);
		}
		return;
	}
	signalTree(pid, "SIGTERM");
	await settle(graceMs);
	if (!treeAlive(pid, descendants)) return;
	// Every captured PID can exit and be reused during the grace, including the original group leader.
	const table = identities.size ? await readProcessTable({ fresh: true }) : undefined;
	const same = (row: ProcessRow) => row.started !== undefined && table?.rows.get(row.pid)?.started === row.started;
	const safe = [...identities.values()].filter(same);
	// A surviving original member proves the group still belongs to this tree. Do not fall back to the root PID.
	if (safe.some((row) => row.pgid === pid && table?.rows.get(row.pid)?.pgid === pid)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* The group already exited. */
		}
	}
	for (const row of safe) if (processAlive(row.pid)) signalTree(row.pid, "SIGKILL");
	await settle(graceMs);
}

/** Ends this process the way an outside SIGTERM would, so its own handlers (Octocode's graceful shutdown) run first. */
export function terminateSelf(): void {
	process.kill(process.pid, "SIGTERM");
}

/** Trees `killTree` is stopping, so a repeated stop (abort plus timeout) sends one SIGTERM and schedules one SIGKILL. */
const stopping = new Set<number>();

/**
 * SIGTERM to the tree as soon as its descendants are listed, and SIGKILL `graceMs` after (an unref'd timer, so it never
 * holds the process open). The SIGKILL goes only to what still exists then: a tree that closed in time is left alone,
 * and a group id is never reused while any member is alive, so the late signal cannot reach an unrelated process.
 * Descendants that left the group (a detached Chrome, a background bash job) are listed (one asynchronous `ps`) before
 * the SIGTERM, so the root gets the grace to close them itself and they are killed with the rest when it does not.
 * Returns at once: the caller never waits for `ps`.
 */
export function killTree(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
	if (!validPid(pid) || stopping.has(pid)) return;
	stopping.add(pid);
	const stop = (descendants: readonly number[]) => {
		signalTree(pid, "SIGTERM");
		setTimeout(() => {
			stopping.delete(pid);
			killRest(pid, descendants);
		}, graceMs).unref();
	};
	// Windows lists nothing: its job ends the whole tree, now.
	if (process.platform === "win32") stop([]);
	else void descendantPids(pid).then(stop);
}
