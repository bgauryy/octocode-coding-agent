/** Drops a row's clock subscriptions (mark animation and elapsed-time tick); call when the row leaves the transcript. */
export function releaseToolRowState(state: { unmark?: () => void; marking?: unknown; unsubscribe?: () => void }): void {
	state.unmark?.();
	state.unmark = undefined;
	state.marking = undefined;
	state.unsubscribe?.();
	state.unsubscribe = undefined;
}
