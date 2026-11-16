/** The shortest gap between two partial updates the parent receives for one child. */
const UPDATE_INTERVAL_MS = 150;

/**
 * Coalesces updates: the first goes out at once, later ones within the interval are held (only the newest survives) and sent
 * when it ends. `urgent` updates, and any update once `live()` is false, go out immediately and drop the held one. The timer
 * is unref'd, fires once, and a held update is dropped when the run has ended by then.
 */
export function throttled<T>(send: (update: T) => void, live: () => boolean, intervalMs = UPDATE_INTERVAL_MS) {
	let last = Number.NEGATIVE_INFINITY;
	let held: { update: T } | undefined;
	let timer: NodeJS.Timeout | undefined;
	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		held = undefined;
	};
	const emit = (update: T) => {
		last = Date.now();
		send(update);
	};
	return (update: T, urgent: boolean) => {
		if (urgent || !live()) {
			clear();
			emit(update);
			return;
		}
		const wait = last + intervalMs - Date.now();
		if (wait <= 0) {
			clear();
			emit(update);
			return;
		}
		held = { update };
		if (timer) return;
		timer = setTimeout(() => {
			const pending = held;
			clear();
			if (pending && live()) emit(pending.update);
		}, wait);
		timer.unref();
	};
}
