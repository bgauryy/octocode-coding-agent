import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The compaction `details` key that names how this summary was written: `{ method: 'cache-shared' }`, or
 * `{ method: 'standalone', reason }` with why the cache-sharing request was not used; `ms` is how long writing it took
 * (the time the compaction held the turn) and `early` says when an early summary was used. Without it the method could
 * only be guessed from the cache numbers of the request.
 */
export const SUMMARY_METHOD_DETAILS = "summaryMethod";

/** How Octocode wrote the summary of a compaction entry's `details` (`cache-shared`, `standalone`); undefined when it did not (Octocode's default summary, another feature's). */
export function summaryMethodOf(details: unknown): string | undefined {
	const method =
		isRecord(details) && isRecord(details[SUMMARY_METHOD_DETAILS]) ? details[SUMMARY_METHOD_DETAILS].method : undefined;
	return typeof method === "string" ? method : undefined;
}

/** How long Octocode took to write the summary of a compaction entry's `details`, in ms; undefined when not recorded. */
export function summaryMethodMs(details: unknown): number | undefined {
	const ms =
		isRecord(details) && isRecord(details[SUMMARY_METHOD_DETAILS]) ? details[SUMMARY_METHOD_DETAILS].ms : undefined;
	return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
