/** How often a wait on the host's full-run lock looks at it: its release is a file removal, which nothing announces. */
const RUN_LOCK_POLL_MS = 3_000;

/** Calls `poke` on an interval until the returned function is called; the timer never keeps the process alive. */
export function watchRunLock(poke: () => void, everyMs = RUN_LOCK_POLL_MS): () => void {
	const timer = setInterval(poke, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
