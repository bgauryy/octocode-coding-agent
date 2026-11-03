import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The compaction `details` key that names how this summary was written: `{ method: 'cache-shared' }`, or
 * `{ method: 'standalone', reason }` with why the cache-sharing request was not used. Without it the method could
 * only be guessed from the cache numbers of the request.
 */
export const SUMMARY_METHOD_DETAILS = "summaryMethod";

/** How Octocode wrote the summary of a compaction entry's `details` (`cache-shared`, `standalone`); undefined when it did not (Octocode's default summary, another extension's). */
export function summaryMethodOf(details: unknown): string | undefined {
	const method =
		isRecord(details) && isRecord(details[SUMMARY_METHOD_DETAILS]) ? details[SUMMARY_METHOD_DETAILS].method : undefined;
	return typeof method === "string" ? method : undefined;
}
