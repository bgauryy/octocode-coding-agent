import type { SessionState } from "./state.ts";

/** The first retry of held records comes this long after the lock was not free; each later one waits twice as long. */
const RETRY_MIN_MS = 100;
/** The longest pause between two retries. */
const RETRY_MAX_MS = 2000;

const timers = new WeakMap<SessionState, NodeJS.Timeout>();

/**
 * Writes the records `state` holds in memory (`unwritten`) once the session lock is free, without waiting for the next
 * record: a run that ends, or waits for its user, right after a held record would otherwise keep it in memory until the
 * session is retired. `write` tries once with the short lock wait and leaves the records held when the lock is still
 * taken. The timer never keeps the process alive; a record still held at exit is tried again when the session retires.
 */
export function retryHeldEntries(
	state: SessionState,
	write: (state: SessionState) => void,
	delayMs = RETRY_MIN_MS,
): void {
	if (timers.has(state)) return;
	const timer = setTimeout(() => {
		timers.delete(state);
		if (state.unwritten.length === 0 || state.persistenceFailure) return;
		write(state);
		if (state.unwritten.length > 0 && !state.persistenceFailure)
			retryHeldEntries(state, write, Math.min(delayMs * 2, RETRY_MAX_MS));
	}, delayMs);
	timer.unref();
	timers.set(state, timer);
}
