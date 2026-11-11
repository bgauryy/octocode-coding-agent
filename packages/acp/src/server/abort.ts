/**
 * `pending`, unless `signal` aborts first: then it rejects with "Cancelled" and `pending`'s own failure is ignored.
 * Common's `untilAborted` rejects with the signal's reason instead; the ACP server answers its client with this fixed
 * text whatever aborted the request.
 */
export async function withAbort<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
	if (signal.aborted) {
		void pending.catch(() => {});
		throw new Error("Cancelled");
	}
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("Cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
