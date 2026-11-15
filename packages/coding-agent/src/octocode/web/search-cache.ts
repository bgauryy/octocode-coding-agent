import { sharedRequests } from "./page-cache.ts";
import { search } from "./search.ts";

type Search = typeof search;
type SearchOutcome = Awaited<ReturnType<Search>>;

/** Search answers are reused this long, up to this many. */
const TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 32;
const API_KEYS = ["TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY", "BRAVE_API_KEY"] as const;

/**
 * A search with its answers cached by provider chain (the configured API keys: the keyless providers always follow),
 * normalized query and result limit. Callers asking the same thing share one search, aborted once every caller has
 * stopped waiting. A failure and an answer without hits are never kept, so the next call asks the providers again.
 */
export function cachedSearch(run: Search = search, now: () => number = Date.now): Search {
	/** Least recently used first. */
	const cache = new Map<string, { at: number; outcome: SearchOutcome }>();
	const share = sharedRequests<SearchOutcome>();

	return async function searchOnce(query, max, env, signal) {
		signal?.throwIfAborted();
		const key = JSON.stringify([
			API_KEYS.filter((name) => env[name]),
			query.trim().replace(/\s+/g, " ").toLowerCase(),
			max,
		]);
		const hit = cache.get(key);
		if (hit && now() - hit.at < TTL_MS) {
			cache.delete(key);
			cache.set(key, hit);
			return hit.outcome;
		}
		cache.delete(key);
		return share(
			key,
			(shared) =>
				run(query, max, env, shared).then((outcome) => {
					if (outcome.hits.length > 0) {
						cache.set(key, { at: now(), outcome });
						while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
					}
					return outcome;
				}),
			signal,
		);
	};
}
