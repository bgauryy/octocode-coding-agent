import { untilAborted } from "@octocodeai/octocode-common/abort";

/** A fetched page is reused for this long at most, up to this many pages and bytes in all. */
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 64;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** What a response says about reusing it: how long it stays fresh, and the validators that let the server confirm it. */
export interface Freshness {
	/** `Cache-Control: no-store`: the page is not kept at all. */
	noStore: boolean;
	ttlMs: number;
	etag?: string;
	lastModified?: string;
}

/** Reads `Cache-Control` (`no-store`, `no-cache`, `max-age`), `ETag` and `Last-Modified`; without a max-age a page stays fresh for the default time. */
export function freshnessOf(headers: Headers): Freshness {
	const control = (headers.get("cache-control") ?? "").toLowerCase();
	const maxAge = /(?:^|[\s,])max-age=(\d+)/.exec(control)?.[1];
	const ttlMs = /(?:^|[\s,])no-cache(?:[\s,=]|$)/.test(control)
		? 0
		: Math.min(maxAge === undefined ? CACHE_TTL_MS : Number(maxAge) * 1000, CACHE_TTL_MS);
	const etag = headers.get("etag") ?? undefined;
	const lastModified = headers.get("last-modified") ?? undefined;
	return {
		noStore: /(?:^|[\s,])no-store(?:[\s,=]|$)/.test(control),
		ttlMs,
		...(etag && { etag }),
		...(lastModified && { lastModified }),
	};
}

/** The request headers that ask the server whether a stored copy is still current. */
export function conditionalHeaders(entry: Freshness): Record<string, string> {
	return {
		...(entry.etag && { "if-none-match": entry.etag }),
		...(entry.lastModified && { "if-modified-since": entry.lastModified }),
	};
}

export interface PageEntry extends Freshness {
	text: string;
	/** When the entry stops being fresh. */
	expires: number;
	bytes: number;
}

/** Page text by URL, least recently used evicted first. An entry past its time stays only when it can be revalidated. */
export function pageCache(now: () => number = Date.now) {
	/** Least recently used first (a Map keeps insertion order; a hit re-inserts). */
	const entries = new Map<string, PageEntry>();
	let cachedBytes = 0;

	function remove(url: string): void {
		cachedBytes -= entries.get(url)?.bytes ?? 0;
		entries.delete(url);
	}

	return {
		/** The entry for `url`, fresh or stale; a fresh hit counts as use. */
		get(url: string): { entry: PageEntry; fresh: boolean } | undefined {
			const entry = entries.get(url);
			if (!entry) return undefined;
			const fresh = now() < entry.expires;
			if (fresh) {
				entries.delete(url);
				entries.set(url, entry);
			}
			return { entry, fresh };
		},
		/** Keeps `text` unless the server forbade it or it can be neither fresh nor revalidated. */
		set(url: string, text: string, freshness: Freshness): void {
			remove(url);
			if (freshness.noStore || (freshness.ttlMs <= 0 && !freshness.etag && !freshness.lastModified)) return;
			const bytes = Buffer.byteLength(text);
			entries.set(url, { ...freshness, text, bytes, expires: now() + freshness.ttlMs });
			cachedBytes += bytes;
			while (entries.size > 1 && (entries.size > CACHE_MAX || cachedBytes > CACHE_MAX_BYTES))
				remove(entries.keys().next().value!);
		},
		/** A 304 confirmed the entry: fresh again, under the headers the server sent with it. */
		renew(url: string, entry: PageEntry, headers: Headers): void {
			const next = freshnessOf(headers);
			this.set(url, entry.text, {
				...next,
				etag: next.etag ?? entry.etag,
				lastModified: next.lastModified ?? entry.lastModified,
			});
		},
		delete: remove,
	};
}

/**
 * Callers asking for the same key share one request, aborted once every caller has stopped waiting. `start` gets the
 * shared request's signal; the request is forgotten when it settles.
 */
export function sharedRequests<T>() {
	const inFlight = new Map<string, { promise: Promise<T>; controller: AbortController; waiting: number }>();
	return async function share(
		key: string,
		start: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		let entry = inFlight.get(key);
		if (!entry) {
			const controller = new AbortController();
			const promise: Promise<T> = start(controller.signal).finally(() => {
				if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
			});
			// Every caller may have stopped waiting; the abort rejection then has no other handler.
			promise.catch(() => undefined);
			entry = { promise, controller, waiting: 0 };
			inFlight.set(key, entry);
		}
		entry.waiting += 1;
		try {
			return await untilAborted(entry.promise, signal);
		} finally {
			entry.waiting -= 1;
			if (entry.waiting === 0 && signal?.aborted) entry.controller.abort(signal.reason);
		}
	};
}
