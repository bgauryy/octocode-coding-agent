/**
 * A time limit for one piece of work: `signal` aborts after `ms` (with the `TimeoutError` that `AbortSignal.timeout`
 * uses) or when `parent` aborts (with its reason). Call `clear()` once the work is done.
 *
 * `AbortSignal.timeout` cannot be cleared, and a pending timer keeps the async context it was created in alive until it
 * fires: a 20 s limit on a call that took 50 ms holds that context, and every session, request or tool call it refers to,
 * for 20 s more. `clear()` releases the timer and the parent listener at once.
 */
export interface Deadline {
	signal: AbortSignal;
	clear(): void;
}

export function deadline(ms: number, parent?: AbortSignal): Deadline {
	const controller = new AbortController();
	const onParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) onParent();
	else parent?.addEventListener("abort", onParent, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException(`The operation was aborted due to timeout`, "TimeoutError")),
		ms,
	);
	// Like `AbortSignal.timeout`: the limit alone never keeps the process alive.
	timer.unref?.();
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParent);
		},
	};
}
