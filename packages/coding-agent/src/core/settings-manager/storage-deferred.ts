import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWriteFileSync, tempSibling, writeTargetSync } from "@octocodeai/octocode-common/atomic-file";
import { LOCK_ATTEMPTS, LOCK_RETRY_DELAY_MS, lockSyncWithRetry } from "@octocodeai/octocode-common/file-write-lock";

/** A settings change computed in memory and not yet in its file. */
interface PendingWrite {
	/** The file content this process will commit: every reader in the process sees it first. */
	content: string;
	/** The file content `content` was computed from; the commit takes the fast path while the file still holds it. */
	base: string | undefined;
	/** The merge of the newest change: what the commit applies again when the file changed meanwhile. */
	merge: (current: string | undefined) => string | undefined;
	started: boolean;
	temp?: string;
	done: Promise<void>;
}

/** Settings files with a write in flight in this process, by path. */
const pending = new Map<string, PendingWrite>();
/** Temp files being written, removed at exit when their write never finished. */
const temps = new Set<string>();

let deferring = false;

/**
 * Commit settings writes of this process off the event loop from now on (the interactive terminal, where a key that
 * changes a setting must not wait for a file lock and two fsyncs). Other processes keep writing synchronously.
 */
export function deferSettingsWrites(): void {
	deferring = true;
}

/** Whether settings writes of this process commit off the event loop. */
export function settingsWritesDeferred(): boolean {
	return deferring;
}

const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf-8") : undefined);

/** The content this process last decided for `path`: its pending write, else the file. */
export function readSettingsFile(path: string): string | undefined {
	return pending.get(path)?.content ?? readIfExists(path);
}

/** A synchronous write committed `content` (merged onto the pending content): pending writes now build on it. */
export function noteSettingsWritten(path: string, content: string): void {
	const entry = pending.get(path);
	if (!entry) return;
	entry.content = content;
	if (!entry.started) entry.base = content;
}

/** The lock without blocking the thread: one attempt at a time, waiting asynchronously between attempts. */
async function lockSettingsFile(path: string): Promise<() => void> {
	for (let attempt = 1; ; attempt++) {
		try {
			return lockSyncWithRetry(path, { attempts: 1 });
		} catch (error) {
			if ((error as { code?: unknown }).code !== "ELOCKED" || attempt >= LOCK_ATTEMPTS) throw error;
			await sleep(LOCK_RETRY_DELAY_MS);
		}
	}
}

async function writeTemp(temp: string, target: string, content: string): Promise<void> {
	const mode = await fsp.stat(target).then(
		(stat) => stat.mode & 0o7777,
		() => undefined,
	);
	const handle = await fsp.open(temp, "wx", mode ?? 0o666);
	try {
		await handle.writeFile(content);
		if (mode !== undefined) await handle.chmod(mode);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(dir: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fsp.open(dir, "r").catch(() => undefined);
	try {
		await handle?.sync();
	} catch {
		// Some filesystems cannot fsync a directory; the rename is atomic anyway.
	} finally {
		await handle?.close();
	}
}

/**
 * Commit `entry`: the temp file is written and fsynced without the lock; under the lock (synchronous, never held across
 * an await) the temp replaces the file when the file still holds `base`, else the newest merge is applied to the file
 * as it is now. The same lock as every other settings writer, so no process loses another's change.
 */
async function commit(path: string, entry: PendingWrite): Promise<void> {
	entry.started = true;
	let committed = false;
	try {
		if (!existsSync(dirname(path))) await fsp.mkdir(dirname(path), { recursive: true });
		const target = writeTargetSync(path);
		entry.temp = tempSibling(target);
		temps.add(entry.temp);
		await writeTemp(entry.temp, target, entry.content);
		const release = await lockSettingsFile(path);
		try {
			const current = readIfExists(path);
			if (current === entry.base) {
				renameSync(entry.temp, target);
				committed = true;
			} else {
				const merged = entry.merge(current);
				if (merged !== undefined) atomicWriteFileSync(path, merged);
			}
		} finally {
			release();
		}
	} finally {
		if (pending.get(path) === entry) pending.delete(path);
		if (entry.temp) {
			if (!committed) await fsp.rm(entry.temp, { force: true });
			temps.delete(entry.temp);
		}
		if (pending.size === 0) process.off("exit", commitPendingAtExit);
	}
	if (committed) await syncDirectory(dirname(path));
}

/** At exit nothing waits for a pending write: commit each one synchronously, as the write it replaced did. */
function commitPendingAtExit(): void {
	for (const temp of temps) rmSync(temp, { force: true });
	for (const [path, entry] of pending) {
		try {
			if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
			const release = lockSyncWithRetry(path);
			try {
				const current = readIfExists(path);
				const merged = current === entry.base ? entry.content : entry.merge(current);
				if (merged !== undefined) atomicWriteFileSync(path, merged);
			} finally {
				release();
			}
		} catch {
			// The process is ending: a write that cannot take the lock is lost, as it would be on a crash.
		}
	}
	pending.clear();
}

/**
 * Apply `merge` to the settings file at `path` off the event loop. The merged content is decided now, on top of this
 * process's pending content, and every reader in the process sees it at once (`readSettingsFile`). Changes made before
 * the write starts join it (the newest merge carries every changed field); the file is committed with the lock
 * (`commit`), and synchronously at process exit if it is still pending then.
 */
export function writeSettingsFileDeferred(
	path: string,
	merge: (current: string | undefined) => string | undefined,
): Promise<void> {
	const previous = pending.get(path);
	if (previous && !previous.started) {
		const content = merge(previous.content);
		if (content !== undefined) previous.content = content;
		previous.merge = merge;
		return previous.done;
	}
	const base = previous ? previous.content : readIfExists(path);
	const content = merge(base);
	if (content === undefined) return previous?.done ?? Promise.resolve();
	const entry: PendingWrite = { content, base, merge, started: false, done: Promise.resolve() };
	if (pending.size === 0) process.on("exit", commitPendingAtExit);
	pending.set(path, entry);
	entry.done = (previous?.done ?? Promise.resolve()).catch(() => undefined).then(() => commit(path, entry));
	return entry.done;
}
