import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import lockfile from "proper-lockfile";
import { keptOwnStart, ownStartAsync } from "./own-start.ts";
import { processStartAsync } from "./process-start.ts";

/**
 * Who holds a `proper-lockfile` lock, recorded beside it (`<lock>.owner`), so a lock left by a process that was killed
 * or crashed is taken over at once instead of after the library's 10 s stale limit. The record names the process by
 * pid, host and start time, and the lock directory it created (device, inode and birth time): a record left
 * by an earlier holder never matches a later lock. A lock is broken only when its recorded owner is verifiably gone:
 * on this host, and no process has its pid, or the process with that pid is a zombie or started at another time (a
 * reused pid). A live owner, an owner on another host, a missing or unreadable record, or a directory the record does
 * not describe: the lock is treated as held, as before. Nothing here waits or runs `ps` on the calling thread: start
 * times are read in the background, and until a verdict arrives the owner counts as alive.
 */

interface LockOwner {
	pid: number;
	host: string;
	started?: string;
	dir: string;
	token?: string;
}

const HOST = hostname();
const ownerPath = (lockfilePath: string): string => `${lockfilePath}.owner`;

function directoryIdentity(lockfilePath: string): string | undefined {
	const stat = fs.statSync(lockfilePath, { bigint: true, throwIfNoEntry: false });
	return stat?.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined;
}

function sameDirectory(lockfilePath: string, recorded: string): boolean {
	const current = directoryIdentity(lockfilePath);
	return current !== undefined && recorded === current;
}

/** This process's start time once its one background read answered (`own-start.ts`); asked on first use. */
function ownStartTime(): string | undefined {
	const known = keptOwnStart();
	if (known) return known.started;
	// Never rejects; the answer is kept for the next record.
	void ownStartAsync();
	return undefined;
}

/**
 * Right after taking the lock at `lockfilePath`: record this process as its owner. Returns cleanup for after release:
 * removing this holder's record. A record that cannot be written leaves the owner unknown, which is today's behavior.
 * `dir`: the lock directory's identity when the caller just read it.
 */
export function recordLockOwner(lockfilePath: string, dir = directoryIdentity(lockfilePath)): () => void {
	return writeLockOwner(lockfilePath, dir).forget;
}

/** `recordLockOwner`, also telling whether this call wrote the record. */
function writeLockOwner(lockfilePath: string, dir: string | undefined): { written: boolean; forget: () => void } {
	let recorded: string | undefined;
	let written = false;
	try {
		recorded = ownerRecord(lockfilePath, dir);
		if (recorded) {
			fs.writeFileSync(ownerPath(lockfilePath), recorded, { mode: 0o600 });
			written = true;
		}
	} catch {
		// Unknown owner: waiters fall back to the stale limit.
	}
	return { written, forget: forgetLockOwner(lockfilePath, recorded) };
}

function ownerRecord(lockfilePath: string, dir = directoryIdentity(lockfilePath)): string | undefined {
	if (!dir) return undefined;
	const owner: LockOwner = { pid: process.pid, host: HOST, started: ownStartTime(), dir, token: randomUUID() };
	return JSON.stringify(owner);
}

/** Async acquisitions publish metadata before the mutation without a synchronous disk write. */
async function recordLockOwnerAsync(lockfilePath: string, dir: string | undefined): Promise<() => void> {
	let recorded: string | undefined;
	const temporary = `${ownerPath(lockfilePath)}.pending-${randomUUID()}`;
	try {
		recorded = dir === undefined ? undefined : ownerRecord(lockfilePath, dir);
		if (recorded) {
			await fs.promises.writeFile(temporary, recorded, { mode: 0o600, flag: "wx" });
			// Publish only complete metadata, without overwriting a successor's record or its open inode.
			if (directoryIdentity(lockfilePath) === dir) {
				try {
					await fs.promises.link(temporary, ownerPath(lockfilePath));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					// A prior holder can exit between releasing its directory and forgetting its sidecar.
					const previous = fs.readFileSync(ownerPath(lockfilePath), "utf8");
					const owner = parseOwner(previous);
					if (owner && !sameDirectory(lockfilePath, owner.dir) && directoryIdentity(lockfilePath) === dir) {
						forgetLockOwner(lockfilePath, previous)();
						if (directoryIdentity(lockfilePath) === dir) await fs.promises.link(temporary, ownerPath(lockfilePath));
					}
				}
			}
		}
	} catch {
		// The same conservative fallback as a synchronous acquisition with unreadable metadata.
	} finally {
		await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
	}
	return forgetLockOwner(lockfilePath, recorded);
}

function forgetLockOwner(lockfilePath: string, recorded: string | undefined): () => void {
	return () => {
		try {
			// A replaced lock belongs to a successor, whose record this holder must leave alone.
			if (recorded !== undefined && fs.readFileSync(ownerPath(lockfilePath), "utf8") === recorded)
				fs.rmSync(ownerPath(lockfilePath), { force: true });
		} catch {
			// Owner metadata is best-effort; a stale record cannot match a new directory.
		}
	};
}

function readOwner(lockfilePath: string): LockOwner | undefined {
	try {
		return parseOwner(fs.readFileSync(ownerPath(lockfilePath), "utf8"));
	} catch {
		// No record, or one being written.
		return undefined;
	}
}

function parseOwner(recorded: string): LockOwner | undefined {
	try {
		const owner = JSON.parse(recorded) as Partial<LockOwner> | null;
		if (
			typeof owner?.pid === "number" &&
			Number.isInteger(owner.pid) &&
			owner.pid > 0 &&
			typeof owner.host === "string" &&
			typeof owner.dir === "string" &&
			(owner.started === undefined || typeof owner.started === "string") &&
			(owner.token === undefined || typeof owner.token === "string")
		)
			return owner as LockOwner;
	} catch {
		// No record, or one being written.
	}
	return undefined;
}

/**
 * Background verdicts on owners that were alive when asked: `zombie` (exited, not yet reaped), `other` (the pid names a
 * process that started at another time: a reused pid), `alive` (the owner, or one that cannot be told apart without a
 * recorded start).
 */
type Verdict = { value: "alive" | "other" | "zombie"; at: number };
const verdicts = new Map<string, Verdict | symbol>();
const VERDICTS_KEPT = 64;
const VERDICT_RECHECK_MS = 1000;

function askVerdict(key: string, owner: LockOwner): void {
	const request = Symbol("asking");
	verdicts.set(key, request);
	if (verdicts.size > VERDICTS_KEPT) verdicts.delete(verdicts.keys().next().value!);
	void processStartAsync(owner.pid).then((read) => {
		// A completed read must not restore an evicted entry or replace a newer request for the same owner.
		if (verdicts.get(key) !== request) return;
		const value = read?.zombie
			? "zombie"
			: read && owner.started !== undefined && read.started !== owner.started
				? "other"
				: "alive";
		// Unknown readings stay held too, briefly cached so a denied ps does not spawn once per lock retry.
		verdicts.set(key, { value, at: performance.now() });
	});
}

/** Whether `pid` names no process (EPERM: one exists that this user cannot signal). */
function noSuchProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Whether the recorded owner is verifiably gone; never blocks. */
function ownerGone(owner: LockOwner): boolean {
	if (owner.host !== HOST || owner.pid === process.pid) return false;
	if (noSuchProcess(owner.pid)) return true;
	const key = `${owner.pid} ${owner.started ?? ""}`;
	const verdict = verdicts.get(key);
	const read = typeof verdict === "object" ? verdict : undefined;
	if (verdict === undefined || (read?.value === "alive" && performance.now() - read.at >= VERDICT_RECHECK_MS))
		askVerdict(key, owner);
	return read?.value === "zombie" || read?.value === "other";
}

/**
 * With `lockfilePath` held by someone else: remove it when its recorded owner is verifiably gone, and report whether it
 * did. Breakers take turns on a second lock (`<lock>.break`) and check again under it, so one that saw a dead owner
 * never removes a lock a new owner took meanwhile. False also when the turn is not free: the caller waits as before.
 */
export function breakDeadLockSync(lockfilePath: string): boolean {
	const owner = readOwner(lockfilePath);
	if (!owner || !ownerGone(owner) || !sameDirectory(lockfilePath, owner.dir)) return false;
	let release: (() => void) | undefined;
	try {
		release = lockfile.lockSync(lockfilePath, { realpath: false, lockfilePath: `${lockfilePath}.break` });
	} catch {
		return false;
	}
	try {
		const current = readOwner(lockfilePath);
		if (
			!current ||
			current.pid !== owner.pid ||
			current.started !== owner.started ||
			current.dir !== owner.dir ||
			current.token !== owner.token
		)
			return false;
		if (!sameDirectory(lockfilePath, owner.dir)) return false;
		fs.rmSync(ownerPath(lockfilePath), { force: true });
		fs.rmdirSync(lockfilePath);
		return true;
	} catch {
		return false;
	} finally {
		try {
			release();
		} catch {
			// A break turn that cannot be released goes stale.
		}
	}
}

/**
 * Protect a recorded owner before acquisition and again at the library's stale-removal point. Locks without a
 * matching record retain the library's stale timeout. After acquisition, release uses the caller's own filesystem guard.
 */
interface LockFileSystem extends Pick<
	typeof fs,
	"stat" | "statSync" | "utimes" | "utimesSync" | "realpath" | "realpathSync"
> {
	mkdir(target: fs.PathLike, callback: fs.NoParamCallback): void;
	mkdirSync(target: fs.PathLike): void;
	rmdir(target: fs.PathLike, callback: fs.NoParamCallback): void;
	rmdirSync(target: fs.PathLike, options?: fs.RmDirOptions): void;
}

interface LockOwnerGuard {
	check(): void;
	fs: LockFileSystem;
	acquired(): () => void;
	acquiredAsync(): Promise<() => void>;
	assertHeld(): void;
}

export function guardLockOwner(lockfilePath: string, base: LockFileSystem = fs): LockOwnerGuard {
	let acquiring = true;
	let observed: string | undefined;
	let created: string | undefined;
	let held: string | undefined;
	/** A synchronous acquisition wrote its owner record itself (not a successor's, not an asynchronous publication). */
	let wroteRecord = false;
	/** This holder's record was removed with its directory still in place, so release has nothing left to forget. */
	let forgotten = false;
	const locked = () =>
		Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: lockfilePath });
	const check = () => {
		observed = directoryIdentity(lockfilePath);
		// No lock directory: no record can describe it, so the free lock costs one stat.
		if (observed === undefined) return;
		const owner = readOwner(lockfilePath);
		if (owner?.dir !== observed) return;
		if (!(ownerGone(owner) && breakDeadLockSync(lockfilePath))) throw locked();
		observed = directoryIdentity(lockfilePath);
	};
	const beforeRemoval = (target: fs.PathLike) => {
		if (String(target) !== lockfilePath) return true;
		const current = directoryIdentity(lockfilePath);
		if (!acquiring) {
			if (held === undefined || current !== held) return false;
			if (!wroteRecord) return true;
			// While this holder's directory stands, no other acquirer can publish a record: the record this holder wrote is
			// removed without reading it back. A missing record only ever makes waiters wait.
			try {
				fs.rmSync(ownerPath(lockfilePath), { force: true });
				forgotten = true;
			} catch {
				// Left to the release's own forget, which checks the record before removing it.
			}
			return true;
		}
		// A failed probe can clean up the directory this attempt just created. A stale takeover must still name the
		// directory checked before acquisition, including when a successor has not published its owner record yet.
		if (created !== undefined && current === created) return true;
		if (current !== observed) throw locked();
		const owner = readOwner(lockfilePath);
		// Never reclaim here: an explicit break would remove the old directory before the library's second rmdir.
		if (owner && sameDirectory(lockfilePath, owner.dir)) throw locked();
		return true;
	};
	return {
		check,
		fs: {
			...base,
			mkdirSync: (target: fs.PathLike) => {
				base.mkdirSync(target);
				if (String(target) === lockfilePath) created = directoryIdentity(lockfilePath);
			},
			mkdir: (target: fs.PathLike, callback: fs.NoParamCallback) => {
				base.mkdir(target, (error) => {
					if (!error && String(target) === lockfilePath) created = directoryIdentity(lockfilePath);
					callback(error);
				});
			},
			rmdirSync: (target: fs.PathLike, ...rest: [fs.RmDirOptions?]) => {
				if (beforeRemoval(target)) base.rmdirSync(target, ...rest);
			},
			rmdir: (target: fs.PathLike, callback: fs.NoParamCallback) => {
				try {
					if (!beforeRemoval(target)) return callback(null);
				} catch (error) {
					return callback(error as NodeJS.ErrnoException);
				}
				base.rmdir(target, callback);
			},
		},
		acquired: () => {
			acquiring = false;
			held = directoryIdentity(lockfilePath);
			const { written, forget } = writeLockOwner(lockfilePath, held);
			wroteRecord = written;
			return () => {
				if (!forgotten) forget();
			};
		},
		acquiredAsync: async () => {
			acquiring = false;
			held = created;
			return recordLockOwnerAsync(lockfilePath, held);
		},
		assertHeld: () => {
			if (held === undefined || directoryIdentity(lockfilePath) !== held)
				throw Object.assign(new Error("Another process took over the file lock; nothing was written."), {
					code: "ECOMPROMISED",
					file: lockfilePath,
				});
		},
	};
}
