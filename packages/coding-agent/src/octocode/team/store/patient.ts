import { isBusy } from "../../../../../db/src/api.ts";
import { BUSY_MS, PATIENT_PAUSE_MS } from "./limits.ts";

/** What `patiently` needs of the store: a run that never waits inside SQLite (`TeamStore.quick`). */
interface QuickRunner {
	quick<T>(work: () => T): T;
}

/** A locked database, also when a caller wrapped SQLite's error in its own. */
export const busy = (error: unknown): boolean =>
	isBusy(error) || (error instanceof Error && error.cause !== undefined && busy(error.cause));

/**
 * A write an agent asked for (a reservation, a message, a join): each attempt is the whole of `work`, so a check and its
 * write stay one transaction, and none waits inside SQLite. While another process holds the database the attempt is
 * repeated after a short pause, as long as the connection's usual busy wait (`BUSY_MS`): the request waits as long as
 * it did, but the thread that draws the screen does not. Rejects with the busy error after that, or when `signal` aborts.
 */
export async function patiently<T>(store: QuickRunner, work: () => T, signal?: AbortSignal): Promise<T> {
	const started = Date.now();
	for (let pause = PATIENT_PAUSE_MS.first; ; pause = Math.min(pause * 2, PATIENT_PAUSE_MS.max)) {
		signal?.throwIfAborted();
		try {
			return store.quick(work);
		} catch (error) {
			if (!busy(error) || Date.now() - started >= BUSY_MS) throw error;
		}
		await new Promise<void>((resolve) => {
			// Each pause removes its own abort listener: a long wait must not pile them up on the caller's signal.
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, pause);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/** Prune when the store opens. A busy database defers the work to the next heartbeat. */
export function pruneIfUnlocked(store: QuickRunner, prune: () => void): void {
	try {
		store.quick(prune);
	} catch (error) {
		if (!isBusy(error)) throw error;
	}
}
