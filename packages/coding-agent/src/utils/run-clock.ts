/**
 * The one clock of a run: from the first `agent_start` to the `agent_settled` that is not followed by a queued message.
 * The working line, the turn line and the notifier read it, so retries, compactions and queued follow-ups
 * (more segments inside the run) never restart it.
 */
let startedAt: number | undefined;
let endedAt: number | undefined;

/** Starts the run at `at`, unless one is already running; returns its start. */
export function beginRun(at: number): number {
	if (startedAt === undefined || endedAt !== undefined) {
		startedAt = at;
		endedAt = undefined;
	}
	return startedAt;
}

/**
 * Ends the run at `at` unless `continuing` (a queued message starts the next segment) and returns its length. Every
 * consumer of `agent_settled` may call it: the first call ends the run, later ones read the same length.
 */
export function settleRun(at: number, continuing: boolean): number | undefined {
	if (startedAt === undefined) return undefined;
	if (endedAt === undefined) {
		if (continuing) return undefined;
		endedAt = at;
	}
	return endedAt - startedAt;
}

/** Forgets the run (a session starts or shuts down). */
export function resetRun(): void {
	startedAt = undefined;
	endedAt = undefined;
}

/** When the latest run began, also while its `agent_settled` is still being dispatched. */
export function lastRunStart(): number | undefined {
	return startedAt;
}

/** When the running run began; undefined between runs. */
export function getRunClock(): number | undefined {
	return endedAt === undefined ? startedAt : undefined;
}
