/** Runs actions one at a time, in order: a failed action does not stop the next, and its caller still sees the failure. */
export function serialQueue(): <T>(action: () => Promise<T>) => Promise<T> {
	let pending: Promise<unknown> = Promise.resolve();
	return <T>(action: () => Promise<T>): Promise<T> => {
		const next = pending.then(action);
		pending = next.catch(() => undefined);
		return next;
	};
}
