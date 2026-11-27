import type { SessionState } from "./state.ts";

/** The first retry of held records comes this long after the lock was not free; each later one waits twice as long. */
const RETRY_MIN_MS = 100;
/** The longest pause between two retries. */
const RETRY_MAX_MS = 2000;
/** Give a short-lived writer time to persist its last record without holding a failed process open forever. */
const EXIT_WAIT_MS = 3000;

const timers = new WeakMap<SessionState, NodeJS.Timeout>();

export function cancelHeldRetry(state: SessionState): void {
	const timer = timers.get(state);
	if (timer) clearTimeout(timer);
	timers.delete(state);
}

/**
 * Writes the records `state` holds in memory (`unwritten`) once the session lock is free, without waiting for the next
 * record: a run that ends, or waits for its user, right after a held record would otherwise keep it in memory until the
 * session is retired. `write` tries once with the short lock wait and leaves the records held when the lock is still
 * taken. Retries keep natural exit alive for up to three seconds. A running host keeps retrying afterward; its explicit
 * session retirement still makes the final bounded flush.
 */
export function retryHeldEntries(
	state: SessionState,
	write: (state: SessionState) => void,
	delayMs = RETRY_MIN_MS,
	exitDeadline = performance.now() + EXIT_WAIT_MS,
): void {
	if (timers.has(state)) return;
	const remaining = exitDeadline - performance.now();
	const timer = setTimeout(
		() => {
			timers.delete(state);
			if (state.unwritten.length === 0 || state.persistenceFailure) return;
			write(state);
			if (state.unwritten.length > 0 && !state.persistenceFailure)
				retryHeldEntries(state, write, Math.min(delayMs * 2, RETRY_MAX_MS), exitDeadline);
		},
		remaining > 0 ? Math.min(delayMs, remaining) : delayMs,
	);
	if (remaining <= 0) timer.unref();
	timers.set(state, timer);
}
