/** Stops waiting without canceling a shared filesystem scan; late failures remain observed. */
export function untilAborted<T>(request: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
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
