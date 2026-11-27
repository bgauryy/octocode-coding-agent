import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileWriteLock } from "./file-write-lock.ts";

/**
 * Crash-safe file replacement: write a sibling temp file, fsync it, rename it over the target and fsync the
 * directory (`durability` can skip the fsyncs). A reader sees the old bytes or the new ones, never a torn file.
 * Symlinks are written through (the link stays a link), and an existing file keeps its mode unless `mode` is set. `atomicWriteFile` can also check, just
 * before the rename, that the target still holds what was read. Async replacements share a cross-process lock;
 * unrelated writers that do not acquire it can still race the content check. Temporary files are removed on failure.
 */

/**
 * What a write flushes before it returns: `all` the data and the directory entry (survives a crash), `data` the data
 * only (a crash may undo the rename and leave the old file), `none` neither (a crash may leave the old file or, on some
 * filesystems, an empty or zeroed one), for derived files that are rebuilt or verified before use. Every level renames
 * a complete temp file, so a reader never sees a torn file.
 */
type WriteDurability = "all" | "data" | "none";

interface AtomicWriteOptions {
	/** File mode of the result (e.g. `0o600` for credentials), applied exactly rather than through the umask. */
	mode?: number;
	/** Default `all`. */
	durability?: WriteDurability;
	signal?: AbortSignal;
	beforeCommit?: () => void;
}

export function sha256(data: string | Uint8Array, encoding: "hex" | "base64url" = "hex"): string {
	return createHash("sha256").update(data).digest(encoding);
}

/** An incremental SHA-256, for a caller that streams bytes it also inspects (`update` each chunk, then `digest`). */
export const sha256Hasher = () => createHash("sha256");

/** The first 16 hex digits of the SHA-256: a short name for content. */
export const shortHash = (data: string | Uint8Array): string => sha256(data).slice(0, 16);

/** The SHA-256 of a regular file, streamed (a large file is never held whole), or undefined when it does not exist (or is not a file). */
export async function sha256File(file: string): Promise<string | undefined> {
	try {
		if (!(await fs.promises.stat(file)).isFile()) return undefined;
		const hash = createHash("sha256");
		for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

export class ChangedOnDiskError extends Error {
	constructor(display: string) {
		super(`${display} changed on disk since it was read. Read it again before modifying it.`);
		this.name = "ChangedOnDiskError";
	}
}

export function changedOnDisk(display: string): ChangedOnDiskError {
	return new ChangedOnDiskError(display);
}

/** A unique hidden temp path next to `file` (same directory, so a rename is atomic). */
export function tempSibling(file: string): string {
	return path.join(path.dirname(file), `.octocode-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
}

/**
 * The filesystem steps of one write. `atomicWriteFileSync` and `atomicWriteFile` drive the same steps (`writeSteps`)
 * through a synchronous or a promise-returning implementation; every step returns its value or a promise of it.
 */
interface WriteIo {
	/** The file a write lands on: symlinks resolved (the link stays a link), `file` itself when it does not exist. */
	realpath(file: string): unknown;
	/** The permission bits of an existing file, else undefined. */
	mode(file: string): unknown;
	/** Create `temp` (exclusive), write `data`, set `mode` exactly when given (open() applies the umask), fsync when `sync`, close. */
	write(temp: string, data: string | Uint8Array, mode: number | undefined, sync: boolean): unknown;
	rename(from: string, to: string): unknown;
	remove(file: string): unknown;
	/** fsync a directory, so the rename survives a crash; some filesystems cannot, and the rename is atomic anyway. */
	syncDirectory(dir: string): unknown;
}

/**
 * The file a write to `file` lands on: symlinks resolved, including dangling ones (writeFileSync creates their missing
 * target and keeps the link), else `file` in its real directory. The directory must exist.
 */
export function writeTargetSync(file: string, hops = 40): string {
	try {
		return fs.realpathSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		let link: string | undefined;
		try {
			link = fs.readlinkSync(file);
		} catch (failure) {
			const code = (failure as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "EINVAL") throw failure;
		}
		if (link !== undefined) {
			if (hops === 0) throw new Error(`Too many symbolic links: ${file}`, { cause: error });
			return writeTargetSync(path.resolve(path.dirname(file), link), hops - 1);
		}
		return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
	}
}

/** Flush a newly created or renamed directory entry where the filesystem supports directory fsync. */
export function syncDirectorySync(dir: string): void {
	if (process.platform === "win32") return;
	try {
		const fd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// See WriteIo.syncDirectory.
	}
}

const syncIo: WriteIo = {
	realpath: writeTargetSync,
	mode: (file) => {
		try {
			return fs.statSync(file).mode & 0o7777;
		} catch {
			return undefined;
		}
	},
	write: (temp, data, mode, sync) => {
		const fd = fs.openSync(temp, "wx", mode ?? 0o666);
		try {
			fs.writeFileSync(fd, data);
			if (mode !== undefined) fs.fchmodSync(fd, mode);
			if (sync) fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	},
	rename: (from, to) => fs.renameSync(from, to),
	remove: (file) => fs.rmSync(file, { force: true }),
	syncDirectory: syncDirectorySync,
};

const asyncIo: WriteIo = {
	realpath: (file) => fs.promises.realpath(file).catch(() => file),
	mode: (file) =>
		fs.promises.stat(file).then(
			(stat) => stat.mode & 0o7777,
			() => undefined,
		),
	write: async (temp, data, mode, sync) => {
		const handle = await fs.promises.open(temp, "wx", mode ?? 0o666);
		try {
			await handle.writeFile(data);
			if (mode !== undefined) await handle.chmod(mode);
			if (sync) await handle.sync();
		} finally {
			await handle.close();
		}
	},
	rename: (from, to) => fs.promises.rename(from, to),
	remove: (file) => fs.promises.rm(file, { force: true }),
	syncDirectory: async (dir) => {
		if (process.platform === "win32") return;
		const handle = await fs.promises.open(dir, "r").catch(() => undefined);
		try {
			await handle?.sync();
		} catch {
			// See WriteIo.syncDirectory.
		} finally {
			await handle?.close();
		}
	},
};

/**
 * The one write sequence: each `yield` hands a step's result (or promise) to the driver and gets its value back.
 * `check` runs on the real target after the temp file is complete and before the rename.
 */
function* writeSteps(
	io: WriteIo,
	file: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions,
	check?: (target: string) => unknown,
): Generator<unknown, void, unknown> {
	const target = (yield io.realpath(file)) as string;
	const temp = tempSibling(target);
	const mode = options.mode ?? ((yield io.mode(target)) as number | undefined);
	const durability = options.durability ?? "all";
	try {
		yield io.write(temp, data, mode, durability !== "none");
		if (check) yield check(target);
		yield io.rename(temp, target);
	} catch (error) {
		yield io.remove(temp);
		throw error;
	}
	if (durability === "all") yield io.syncDirectory(path.dirname(target));
}

/**
 * Synchronous crash-safe write without a content check. A concurrent writer's update can be replaced whole, so a file
 * other processes also write (the trust store) needs its caller to re-read, merge and verify.
 */
export function atomicWriteFileSync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
	const steps = writeSteps(syncIo, file, data, options, options.beforeCommit);
	// A synchronous step has already run (or thrown inside the generator) when it is yielded: pass its value back.
	for (let step = steps.next(); !step.done; step = steps.next(step.value));
}

/**
 * `atomicWriteFileSync` for content produced piece by piece, so a large file is never held whole: `produce` writes
 * chunks through `write` and returns false to leave `file` untouched (the temp file is removed). `beforeCommit` runs after
 * the temp file is complete and flushed, just before the rename. Returns whether the file was replaced.
 */
export function atomicWriteChunksSync(
	file: string,
	produce: (write: (chunk: Uint8Array) => void) => boolean,
	options: AtomicWriteOptions & { mode: number },
): boolean {
	const target = writeTargetSync(file);
	const temp = tempSibling(target);
	const durable = (options.durability ?? "all") !== "none";
	let committed = false;
	try {
		const fd = fs.openSync(temp, "wx", options.mode);
		try {
			fs.fchmodSync(fd, options.mode);
			if (!produce((chunk) => fs.writeFileSync(fd, chunk))) return false;
			if (durable) fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		options.beforeCommit?.();
		fs.renameSync(temp, target);
		committed = true;
	} finally {
		if (!committed) fs.rmSync(temp, { force: true });
	}
	if (options.durability === undefined || options.durability === "all") syncDirectorySync(path.dirname(target));
	return true;
}

/**
 * Replace `file` with `data` atomically. `expectedSha`: a SHA-256 the current content must still have, `null` when
 * the file must still not exist, undefined for no check.
 */
export async function atomicWriteFile(
	file: string,
	data: string | Uint8Array,
	expectedSha?: string | null,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await withFileWriteLock(
		file,
		async (target, assertHeld) => {
			const check = async () => {
				options.signal?.throwIfAborted();
				if (expectedSha !== undefined && ((await sha256File(target)) ?? null) !== expectedSha)
					throw changedOnDisk(file);
				assertHeld();
				options.beforeCommit?.();
			};
			await driveAsync(writeSteps(asyncIo, target, data, options, check));
		},
		options.signal,
	);
}

/**
 * `atomicWriteFile` without its lock or content check, for a caller that holds its own lock: `beforeCommit` (which may
 * be async) runs on the real target after the temp file is complete and just before the rename; a throw there writes nothing.
 */
export async function atomicWriteFileUnlocked(
	file: string,
	data: string | Uint8Array,
	options: Omit<AtomicWriteOptions, "beforeCommit"> & { beforeCommit?: () => void | Promise<void> } = {},
): Promise<void> {
	const { beforeCommit } = options;
	const check = async () => {
		options.signal?.throwIfAborted();
		await beforeCommit?.();
	};
	await driveAsync(writeSteps(asyncIo, file, data, { ...options, beforeCommit: undefined }, check));
}

/** Runs `writeSteps` with each yielded promise awaited and its value (or error) handed back. */
async function driveAsync(steps: Generator<unknown, void, unknown>): Promise<void> {
	let step = steps.next();
	while (!step.done) {
		let value: unknown;
		try {
			value = await step.value;
		} catch (error) {
			step = steps.throw(error);
			continue;
		}
		step = steps.next(value);
	}
}
