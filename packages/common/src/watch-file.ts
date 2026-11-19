import fs from "node:fs";
import path from "node:path";

/** Events of one write (create temp, write, rename over the file) arrive in a burst: one call after it settles. */
const SETTLE_MS = 50;

export interface WatchFileOptions {
	/** Stat interval of the polling fallback. */
	intervalMs?: number;
	/** Poll from the start: for file systems where `fs.watch` misses changes (a Windows drive under WSL). */
	poll?: boolean;
	/** Stat interval of the backstop that runs while the native watcher is armed, for a watcher that goes silent. */
	backstopMs?: number;
}

const DEFAULT_BACKSTOP_MS = 10_000;

type Signature = string | undefined;
function signature(stats: fs.Stats | undefined): Signature {
	return stats && `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

/**
 * Calls `onChange` (at most once per burst) after `file` may have changed: written, created, removed or replaced by a
 * rename (an atomic write). Watches the parent directory and filters by name, since a watch on the file itself loses
 * track once a rename replaces its inode. While the native watcher works, only a slow backstop stat runs (it restarts
 * after every native event, so it stays idle while events arrive) to catch a watcher that went silent, as when macOS
 * fseventsd stalls; a watcher that fails, or a
 * directory that is missing or removed, falls back to stat polling, which re-arms the native watcher once the
 * directory exists again (a watcher that reported an error stays on polling: that file system is not reliable for it).
 * Callers compare the file's revision themselves: a call does not prove a change. Never keeps the process alive.
 * Returns the stop function.
 */
export function watchFileChanges(file: string, onChange: () => void, options: WatchFileOptions = {}): () => void {
	const directory = path.dirname(file);
	const name = path.basename(file);
	const intervalMs = options.intervalMs ?? 1000;
	const backstopMs = options.backstopMs ?? DEFAULT_BACKSTOP_MS;
	let watcher: fs.FSWatcher | undefined;
	let polling = false;
	let unreliable = options.poll === true;
	let stopped = false;
	let settle: ReturnType<typeof setTimeout> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollGeneration = 0;
	let backstopTimer: ReturnType<typeof setTimeout> | undefined;
	let backstopSeen: Signature;
	let backstopGeneration = 0;

	const statNow = (): Signature => {
		try {
			return signature(fs.statSync(file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
				return undefined;
			throw error;
		}
	};
	const stopBackstop = () => {
		backstopGeneration++;
		if (backstopTimer) clearTimeout(backstopTimer);
		backstopTimer = undefined;
	};
	/** (Re)starts the quiet-period timer: a native event or a completed check pushes the next stat out. */
	const scheduleBackstop = () => {
		stopBackstop();
		if (stopped || !watcher || polling) return;
		const generation = backstopGeneration;
		const check = async () => {
			const next = signature(await fs.promises.stat(file).catch(() => undefined));
			if (generation !== backstopGeneration) return;
			if (next !== backstopSeen) {
				backstopSeen = next;
				changed();
			}
			scheduleBackstop();
		};
		backstopTimer = setTimeout(() => void check(), backstopMs);
		backstopTimer.unref?.();
	};

	const changed = () => {
		if (stopped || settle) return;
		settle = setTimeout(() => {
			settle = undefined;
			if (stopped) return;
			if (watcher) {
				backstopSeen = statNow();
				scheduleBackstop();
			}
			onChange();
		}, SETTLE_MS);
		settle.unref?.();
	};
	const closeWatcher = () => {
		const current = watcher;
		watcher = undefined;
		stopBackstop();
		try {
			current?.close();
		} catch {
			// Already closed.
		}
	};
	const startPolling = () => {
		if (polling || stopped) return;
		polling = true;
		const generation = ++pollGeneration;
		let first = true;
		let previous: fs.Stats | undefined;
		const active = () => polling && !stopped && generation === pollGeneration;
		const poll = async () => {
			const next = await fs.promises.stat(file).catch(() => undefined);
			if (!active()) return;
			// An async initial stat can already include a write after registration. Callers compare revisions.
			if (
				first ||
				next?.mtimeMs !== previous?.mtimeMs ||
				next?.ctimeMs !== previous?.ctimeMs ||
				next?.size !== previous?.size
			)
				changed();
			first = false;
			previous = next;
			if (!unreliable && arm()) {
				// Cover a write between the completed stat and installing the native watcher.
				changed();
				stopPolling();
				return;
			}
			// Schedule after completion: slow file systems never accumulate overlapping reads.
			pollTimer = setTimeout(() => void poll(), intervalMs);
			pollTimer.unref?.();
		};
		void poll();
	};
	const stopPolling = () => {
		polling = false;
		pollGeneration++;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	};
	const arm = (): boolean => {
		if (stopped) return false;
		try {
			const next = fs.watch(directory, { persistent: false }, (_event, changedName) => {
				if (watcher !== next) return;
				if (changedName === null || changedName === name) {
					changed();
					scheduleBackstop();
				}
				// The watched directory itself was removed or renamed away: poll until it is back.
				if (!fs.existsSync(directory)) {
					closeWatcher();
					changed();
					startPolling();
				}
			});
			next.on("error", () => {
				if (watcher !== next) return;
				closeWatcher();
				unreliable = true;
				changed();
				startPolling();
			});
			watcher = next;
			backstopSeen = statNow();
			scheduleBackstop();
			return true;
		} catch {
			return false;
		}
	};

	if (unreliable || !arm()) startPolling();
	return () => {
		stopped = true;
		if (settle) clearTimeout(settle);
		settle = undefined;
		closeWatcher();
		stopPolling();
	};
}
