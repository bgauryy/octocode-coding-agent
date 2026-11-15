import { setTimeout as sleep } from "node:timers/promises";
import type { AgentDb } from "./db.ts";
import { busyTimeout, isBusy, RETRY_MS, withBusyTimeout } from "./sqlite.ts";

/** Wait for a peer's write lock without blocking this thread; work must be synchronous and is never replayed once entered. */
export async function transactionWhenReady<T>(agent: AgentDb, work: () => T, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	const deadline = performance.now() + busyTimeout(agent.db);
	let failure: Error | undefined;
	for (;;) {
		signal?.throwIfAborted();
		if (failure !== undefined && performance.now() >= deadline) throw failure;
		let entered = false;
		try {
			return withBusyTimeout(agent.db, 0, (restore) =>
				agent.transaction(() => {
					entered = true;
					restore();
					signal?.throwIfAborted();
					const result = work();
					if (
						result !== null &&
						(typeof result === "object" || typeof result === "function") &&
						"then" in result &&
						typeof result.then === "function"
					) {
						void Promise.resolve(result).catch(() => undefined);
						throw new TypeError(
							"transactionWhenReady requires synchronous work; asynchronous work already started cannot be cancelled.",
						);
					}
					return result;
				}),
			);
		} catch (error) {
			if (entered || !isBusy(error)) throw error;
			failure = error instanceof Error ? error : new Error("Database write lock unavailable", { cause: error });
			const left = deadline - performance.now();
			if (left <= 0) throw error;
			await sleep(Math.min(RETRY_MS, left), undefined, { signal });
		}
	}
}
