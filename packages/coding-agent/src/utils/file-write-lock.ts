import { createHash } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

export class FileLockReleaseError extends Error {
	readonly mutationCompleted = true;
	constructor(file: string, cause: unknown) {
		super(
			`The file mutation completed, but its lock could not be released: ${file}. Inspect the file before retrying.`,
			{ cause },
		);
	}
}

async function writeTarget(file: string, hops = 40): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const link = await readlink(file).catch((failure: NodeJS.ErrnoException) => {
			if (failure.code === "ENOENT" || failure.code === "EINVAL") return undefined;
			throw failure;
		});
		if (link !== undefined) {
			if (hops === 0) throw new Error(`Too many symbolic links: ${file}`);
			return writeTarget(path.resolve(path.dirname(file), link), hops - 1);
		}
		return path.join(await realpath(path.dirname(file)), path.basename(file));
	}
}

/** Serialize cooperating processes through the content check and mutation; shell/editor writes are not excluded. */
export async function withFileWriteLock<T>(
	file: string,
	mutate: (target: string, assertHeld: () => void) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const target = await writeTarget(file);
	const key = createHash("sha256").update(target).digest("hex");
	const deadline = Date.now() + 30_000;
	let compromised: Error | undefined;
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		signal?.throwIfAborted();
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				lockfilePath: path.join(path.dirname(target), `.octocode-${key}.lock`),
				stale: 30_000,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
				},
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
			await sleep(50, undefined, { signal });
		}
	}
	const assertHeld = () => {
		signal?.throwIfAborted();
		if (compromised) throw compromised;
	};
	let completed = false;
	try {
		assertHeld();
		const result = await mutate(target, assertHeld);
		completed = true;
		return result;
	} finally {
		try {
			await release();
		} catch (error) {
			if (completed) throw new FileLockReleaseError(file, error);
		}
	}
}
