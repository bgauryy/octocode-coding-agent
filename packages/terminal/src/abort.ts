/**
 * `request`'s value, or `undefined` once `signal` aborts: stops waiting without canceling a shared filesystem scan, and
 * late failures remain observed. Unlike common's `untilAborted`, an abort is an empty answer, not a rejection, because a
 * superseded completion request has nothing to report.
 */
export function untilSettledOrAborted<T>(request: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		request.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(signal.aborted ? undefined : value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
