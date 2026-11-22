import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { OWNER_AGENT_ENV, OWNER_ITEM_ENV, OWNER_JOB_ENV } from "../packages/common/src/env.ts";
import { processStartAsync } from "../packages/common/src/process-start.ts";

/**
 * One full run at a time on this host: a whole test suite (`vitest` without file filters) or `yarn run check`, across
 * every session, checkout and worktree of this user. Full runs started together each spawn a worker per core and
 * churn temporary files, which overloads the machine; a second run waits for the first and says who holds it.
 *
 * The lock is a directory (`mkdir` is atomic) holding `owner.json`. A holder that was killed is detected by its pid and
 * start time, so its lock is taken over at once. Processes started by the holder inherit `OCTOCODE_RUN_LOCK_HELD` and
 * never wait for their own parent. `OCTOCODE_RUN_LOCK=off` skips the lock. The record names the agent, backlog item and
 * background job the `bash` tool set in the environment of the run (`OCTOCODE_AGENT_NAME`, `OCTOCODE_ITEM`,
 * `OCTOCODE_JOB_ID`), so a waiter sees who holds the lock, not only a pid.
 *
 * Before it takes the lock, a run waits while the host's load per core is above `OCTOCODE_RUN_LOCK_LOAD` (default 2; 0
 * turns the wait off), for at most `OCTOCODE_RUN_LOCK_LOAD_WAIT` seconds (default 300), then goes on. The reading is the
 * kernel's one-minute load average, the figure the machine monitor samples.
 */

export const RUN_LOCK_ENV = "OCTOCODE_RUN_LOCK";
export const RUN_LOCK_HELD_ENV = "OCTOCODE_RUN_LOCK_HELD";

const LOAD_LIMIT_ENV = "OCTOCODE_RUN_LOCK_LOAD";
const LOAD_WAIT_ENV = "OCTOCODE_RUN_LOCK_LOAD_WAIT";
const DEFAULT_LOAD_LIMIT = 2;
const DEFAULT_LOAD_WAIT_SECONDS = 300;

/** A lock directory without an owner record this old was left by a holder killed while taking it. */
const UNRECORDED_STALE_MS = 30_000;

export interface RunLockOwner {
	token: string;
	pid: number;
	started?: string;
	label: string;
	session?: string;
	agent?: string;
	item?: string;
	job?: string;
	cwd: string;
	since: string;
}

export interface RunLockOptions {
	/** What this run is, shown to waiters: `vitest --config vitest.octocode.config.ts in packages/coding-agent`. */
	label: string;
	dir?: string;
	env?: NodeJS.ProcessEnv;
	pollMs?: number;
	/** The host's load per core now; default: the one-minute load average over the core count. */
	load?: () => number | undefined;
	/** Defer while the load per core is above this (default `OCTOCODE_RUN_LOCK_LOAD`); 0 never defers. */
	loadAbove?: number;
	/** The longest the load may defer the run, in ms (default `OCTOCODE_RUN_LOCK_LOAD_WAIT`). */
	loadMaxWaitMs?: number;
	/** How often a waiter repeats who it waits for. */
	noticeMs?: number;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

/** In the OS account's home, not `$HOME`: isolated test homes (`./test.sh`) must share the one lock. */
function defaultRunLockDir(): string {
	return path.join(os.userInfo().homedir, ".octocode", "locks", "full-run");
}

const ownerFile = (dir: string) => path.join(dir, "owner.json");

export function readRunLockOwner(dir: string): RunLockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(ownerFile(dir), "utf8")) as Partial<RunLockOwner> | null;
		return typeof owner?.token === "string" && Number.isInteger(owner.pid) ? (owner as RunLockOwner) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** The agent, item and job the `bash` tool named for this run; unset or blank ones are left out. */
function ownerNames(env: NodeJS.ProcessEnv): Pick<RunLockOwner, "agent" | "item" | "job"> {
	const names: Pick<RunLockOwner, "agent" | "item" | "job"> = {};
	const agent = env[OWNER_AGENT_ENV]?.trim();
	const item = env[OWNER_ITEM_ENV]?.trim();
	const job = env[OWNER_JOB_ENV]?.trim();
	if (agent) names.agent = agent;
	if (item) names.item = item;
	if (job) names.job = job;
	return names;
}

const hostLoad = (): number | undefined => {
	const cores = os.availableParallelism();
	return cores > 0 ? os.loadavg()[0] / cores : undefined;
};

function numberOf(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const value = Number(env[name]);
	return env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The load reflex: wait, polling, while the load per core is above the limit, for at most the bound; one line says it
 * began and one how it ended. Returns how long it waited, in ms.
 */
async function deferForLoad(
	options: RunLockOptions,
	env: NodeJS.ProcessEnv,
	pollMs: number,
	log: (line: string) => void,
): Promise<number> {
	const limit = options.loadAbove ?? numberOf(env, LOAD_LIMIT_ENV, DEFAULT_LOAD_LIMIT);
	const maxMs = options.loadMaxWaitMs ?? numberOf(env, LOAD_WAIT_ENV, DEFAULT_LOAD_WAIT_SECONDS) * 1000;
	const read = options.load ?? hostLoad;
	const busy = () => (read() ?? 0) > limit;
	if (limit <= 0 || maxMs <= 0 || !busy()) return 0;
	const start = Date.now();
	log(
		`Deferring ${options.label} while load is ${read()?.toFixed(1)} per core (limit ${limit}); waits at most ${Math.round(maxMs / 1000)}s.`,
	);
	while (busy() && Date.now() - start < maxMs) await sleep(pollMs, undefined, { signal: options.signal });
	const waited = Date.now() - start;
	log(
		`${busy() ? "Load still high" : "Load dropped"} (${read()?.toFixed(1)} per core) after ${Math.round(waited / 1000)}s: starting.`,
	);
	return waited;
}

function tryTake(dir: string, owner: RunLockOwner): boolean {
	try {
		fs.mkdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	const temporary = `${ownerFile(dir)}.${owner.token}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, ownerFile(dir));
	return true;
}

function ageMs(target: string): number | undefined {
	const stat = fs.statSync(target, { throwIfNoEntry: false });
	return stat ? Date.now() - stat.mtimeMs : undefined;
}

/** Whether the holder has verifiably exited: no such pid, a zombie, or the pid now names a later process. */
async function holderGone(dir: string, holder: RunLockOwner | undefined): Promise<boolean> {
	if (!holder) return (ageMs(dir) ?? 0) > UNRECORDED_STALE_MS;
	try {
		process.kill(holder.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
	}
	if (holder.started === undefined) return false;
	const now = await processStartAsync(holder.pid);
	return now !== undefined && (now.zombie || now.started !== holder.started);
}

/**
 * Remove a lock whose holder is gone. Breakers take turns on `<dir>.break` and check again under it, so one that saw a
 * dead holder never removes the lock a new holder took meanwhile.
 */
function breakStale(dir: string, seen: RunLockOwner | undefined): void {
	const turn = `${dir}.break`;
	try {
		fs.mkdirSync(turn);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// A breaker killed during its turn leaves the turn behind.
		if ((ageMs(turn) ?? 0) > UNRECORDED_STALE_MS) fs.rmSync(turn, { recursive: true, force: true });
		return;
	}
	try {
		const current = readRunLockOwner(dir);
		const same = seen ? current?.token === seen.token : !current && (ageMs(dir) ?? 0) > UNRECORDED_STALE_MS;
		if (same) fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		fs.rmSync(turn, { recursive: true, force: true });
	}
}

function describeRunLockOwner(owner: RunLockOwner | undefined): string {
	if (!owner) return "a run that is starting";
	const named = [
		owner.session && `session ${owner.session}`,
		owner.agent && `agent ${owner.agent}`,
		owner.item && `item ${owner.item}`,
		owner.job && `job ${owner.job}`,
	].filter((part): part is string => Boolean(part));
	return `${owner.label} (${[`pid ${owner.pid}`, ...named].join(", ")}) in ${owner.cwd}, since ${owner.since}`;
}

/**
 * Take the host's full-run lock, waiting while another live run holds it. Returns its release; a no-op when the lock is
 * off or this process descends from the holder.
 */
export async function acquireRunLock(options: RunLockOptions): Promise<() => void> {
	const env = options.env ?? process.env;
	if (env[RUN_LOCK_ENV] === "off" || env[RUN_LOCK_HELD_ENV]) return () => {};
	const dir = options.dir ?? defaultRunLockDir();
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const pollMs = options.pollMs ?? 2000;
	const noticeMs = options.noticeMs ?? 60_000;
	await deferForLoad(options, env, pollMs, log);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const owner: RunLockOwner = {
		token: randomUUID(),
		pid: process.pid,
		started: (await processStartAsync(process.pid))?.started,
		label: options.label,
		session: env.OCTOCODE_SESSION_ID,
		...ownerNames(env),
		cwd: process.cwd(),
		since: new Date().toISOString(),
	};
	const waitStart = Date.now();
	let lastNotice: number | undefined;
	for (;;) {
		if (tryTake(dir, owner)) {
			env[RUN_LOCK_HELD_ENV] = owner.token;
			if (lastNotice !== undefined) log(`Full-run lock taken after ${Math.round((Date.now() - waitStart) / 1000)}s.`);
			return () => {
				if (env[RUN_LOCK_HELD_ENV] === owner.token) delete env[RUN_LOCK_HELD_ENV];
				if (readRunLockOwner(dir)?.token === owner.token) fs.rmSync(dir, { recursive: true, force: true });
			};
		}
		const holder = readRunLockOwner(dir);
		if (await holderGone(dir, holder)) {
			breakStale(dir, holder);
			continue;
		}
		if (lastNotice === undefined || Date.now() - lastNotice >= noticeMs) {
			lastNotice = Date.now();
			log(
				`Waiting for the full run already going on this host: ${describeRunLockOwner(holder)}. One full suite or check runs at a time; runs with file filters do not wait; ${RUN_LOCK_ENV}=off skips the wait.`,
			);
		}
		await sleep(pollMs, undefined, { signal: options.signal });
	}
}

/**
 * Whether the host's full-run lock is free right now. A lock whose holder is gone is removed first (the same `breakStale`
 * a taker runs), so a wait on this answer ends after a killed run instead of waiting on a file nobody removes.
 */
export async function runLockStatus(
	dir: string = defaultRunLockDir(),
): Promise<{ free: true } | { free: false; holder: string }> {
	if (!fs.existsSync(dir)) return { free: true };
	const holder = readRunLockOwner(dir);
	if (await holderGone(dir, holder)) {
		breakStale(dir, holder);
		if (!fs.existsSync(dir)) return { free: true };
	}
	const current = readRunLockOwner(dir);
	return fs.existsSync(dir) ? { free: false, holder: describeRunLockOwner(current) } : { free: true };
}

/** `node scripts/full-run-lock.ts --status`: exit 0 when the lock is free (a dead holder's lock is removed), 1 with the holder when it is held. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv[2] !== "--status") {
		process.stderr.write("usage: node scripts/full-run-lock.ts --status\n");
		process.exit(2);
	}
	const status = await runLockStatus();
	process.stdout.write(status.free ? "free\n" : `held by ${status.holder}\n`);
	process.exit(status.free ? 0 : 1);
}
