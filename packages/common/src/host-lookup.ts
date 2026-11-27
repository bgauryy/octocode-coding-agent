export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

/** Resolves through the system resolver, loaded on first use so importing the guard costs no resolver setup. */
export const defaultLookup: HostLookup = async (hostname) =>
	(await import("node:dns/promises")).lookup(hostname, { all: true, order: "verbatim" });

/**
 * `lookup` that gives up when `signal` aborts, with the signal's reason: the system resolver takes no signal, and one that
 * never answers must not outlast the caller's deadline. The abandoned lookup is left to finish on its own.
 */
export function lookupWithin(lookup: HostLookup | undefined, signal: AbortSignal | undefined): HostLookup {
	const resolve = lookup ?? defaultLookup;
	if (!signal) return resolve;
	return async (hostname) => {
		signal.throwIfAborted();
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([resolve(hostname), aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};
}

/** Runs `step`; a failure after `signal` aborted is the abort (a deadline stays a timeout), not a resolution error. */
export async function abortedOr<T>(signal: AbortSignal | undefined, step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (error) {
		throw signal?.aborted ? signal.reason : error;
	}
}
