import type { AgentEvent } from "../types.ts";

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * Streaming deltas: the final state of each is carried by a later event (`message_end`, `tool_execution_end`), so no
 * listener's result for one is needed to finish a run. Every other event (lifecycle, message start/end, tool start/end)
 * may carry a permission, transformation, state transition or durable commit, and stays awaited even after an abort.
 */
const RELEASED_ON_ABORT: ReadonlySet<AgentEvent["type"]> = new Set(["message_update", "tool_execution_update"]);

/**
 * Deliver `event` to each listener in subscription order, awaiting each before the next.
 *
 * Once the run's `signal` is aborted, the agent stops waiting for a listener still busy with a streaming delta, so
 * a stalled observer cannot hold cancellation. That listener is abandoned: it may still finish, and its later
 * rejection is discarded. A listener that settles before the agent stops waiting keeps its result, and its rejection
 * still fails the run.
 */
export async function deliverAgentEvent(
	listeners: Iterable<AgentEventListener>,
	event: AgentEvent,
	signal: AbortSignal,
): Promise<void> {
	const releasable = RELEASED_ON_ABORT.has(event.type);
	for (const listener of listeners) {
		const result = listener(event, signal);
		if (releasable && result instanceof Promise) await untilSettledOrAborted(result, signal);
		else await result;
	}
}

async function untilSettledOrAborted(delivery: Promise<void>, signal: AbortSignal): Promise<void> {
	// Observed at once, so the rejection of an abandoned listener is never unhandled.
	void delivery.catch(() => {});
	// Already aborted: an already settled delivery still wins the race (its reaction is queued first); a pending one does not.
	if (signal.aborted) return Promise.race([delivery, Promise.resolve()]);
	let onAbort = () => {};
	const aborted = new Promise<void>((resolve) => {
		onAbort = resolve;
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([delivery, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
