/**
 * Raised when a question from the coordinator reached a running session, so a wait at the end of its run ends and the
 * queued question continues the run; renewed once the model is called with it.
 */
export class Asked {
	private pending = new AbortController();

	get signal(): AbortSignal {
		return this.pending.signal;
	}

	raise(): void {
		this.pending.abort();
	}

	/** The model is being called, so a question raised before is in front of it: the next wait holds again. */
	renew(): void {
		if (this.pending.signal.aborted) this.pending = new AbortController();
	}
}
