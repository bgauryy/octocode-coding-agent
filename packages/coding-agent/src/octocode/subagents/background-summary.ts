import type { RunDetails } from "./run-types.ts";

/** The background start row: held, waiting behind prerequisites, started after them, or running. */
export function backgroundSummary(details: RunDetails): string {
	const { id } = details;
	if (details.queued && details.held) return `Queued · held: ${details.held} as ${id}`;
	if (details.queued && details.after?.length) return `Queued · starts after ${details.after.join(", ")} as ${id}`;
	if (details.startedAfter?.length) return `Started after ${details.startedAfter.join(", ")} as ${id}`;
	return `${details.queued ? "Queued in the background" : "Running in the background"} as ${id}`;
}
