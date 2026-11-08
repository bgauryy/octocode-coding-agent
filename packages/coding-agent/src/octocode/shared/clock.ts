/** The cadence of the shared clock. */
const SECOND_MS = 1_000;

interface Subscription {
	listener: () => void;
}

const subscriptions = new Set<Subscription>();
let timer: NodeJS.Timeout | undefined;

function tick(): void {
	let failure: { error: unknown } | undefined;
	for (const subscription of Array.from(subscriptions)) {
		if (!subscriptions.has(subscription)) continue; // stopped by an earlier listener of this tick
		try {
			subscription.listener();
		} catch (error) {
			failure ??= { error };
		}
	}
	// A throw out of a timer is an uncaught exception, which ends the session: report it as a rejection instead, which the
	// session shows as a warning; the failing listener stays subscribed and runs again next second.
	if (failure) void Promise.reject(failure.error);
}

/**
 * Calls `listener` every second until the returned function is called. Every listener shares one unref'd timer, which
 * runs only while one is subscribed: the team ticker, a subagent's parent check and the poll for late reports each wake
 * the event loop once a second, so together they wake it once. Every listener runs even when an earlier one throws; the
 * first error is reported after them as an unhandled rejection, never thrown out of the timer.
 */
export function onSecond(listener: () => void): () => void {
	const subscription: Subscription = { listener };
	subscriptions.add(subscription);
	if (!timer) {
		timer = setInterval(tick, SECOND_MS);
		timer.unref();
	}
	return () => {
		if (!subscriptions.delete(subscription) || subscriptions.size > 0) return;
		clearInterval(timer);
		timer = undefined;
	};
}
