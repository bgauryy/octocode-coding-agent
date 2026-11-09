/** When the current run began, so a working line created mid-run (after a retry or a compaction) keeps the run's clock. */
let runStartedAt: number | undefined;

/** Start (`at`) or end (`undefined`) the run clock the working line counts from. */
export function setRunClock(at: number | undefined): void {
	runStartedAt = at;
}

/** When the current run began; undefined between runs. */
export function getRunClock(): number | undefined {
	return runStartedAt;
}
