import fs from "node:fs";
import path from "node:path";

/** Events of one write (create temp, write, rename over the file) arrive in a burst: one call after it settles. */
const SETTLE_MS = 50;

export interface WatchFileOptions {
	/** Stat interval of the polling fallback. */
	intervalMs?: number;
	/** Poll from the start: for file systems where `fs.watch` misses changes (a Windows drive under WSL). */
	poll?: boolean;
}

/**
 * Calls `onChange` (at most once per burst) after `file` may have changed: written, created, removed or replaced by a
 * rename (an atomic write). Watches the parent directory and filters by name, since a watch on the file itself loses
 * track once a rename replaces its inode. Nothing is polled while the native watcher works; a watcher that fails, or a
 * directory that is missing or removed, falls back to stat polling, which re-arms the native watcher once the
 * directory exists again (a watcher that reported an error stays on polling: that file system is not reliable for it).
 * Callers compare the file's revision themselves: a call does not prove a change. Never keeps the process alive.
 * Returns the stop function.
 */
export function watchFileChanges(file: string, onChange: () => void, options: WatchFileOptions = {}): () => void {
	const directory = path.dirname(file);
	const name = path.basename(file);
	const intervalMs = options.intervalMs ?? 1000;
	let watcher: fs.FSWatcher | undefined;
	let polling = false;
	let unreliable = options.poll === true;
	let stopped = false;
	let settle: ReturnType<typeof setTimeout> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollGeneration = 0;

	const changed = () => {
		if (stopped || settle) return;
		settle = setTimeout(() => {
			settle = undefined;
			if (!stopped) onChange();
		}, SETTLE_MS);
		settle.unref?.();
	};
	const closeWatcher = () => {
		const current = watcher;
		watcher = undefined;
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
				if (changedName === null || changedName === name) changed();
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
