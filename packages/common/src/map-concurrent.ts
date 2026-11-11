/**
 * Maps items with at most `limit` calls in flight and returns results in input order.
 * Use it for independent asynchronous work (I/O, worker threads); synchronous work stays on the calling thread.
 * The signal is checked before each item starts; the first rejection rejects the returned promise.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = [];
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			results[index] = await map(items[index], index);
		}
	};
	const workers = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return results;
}
