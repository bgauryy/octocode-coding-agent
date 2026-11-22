/** Why the last model reload or refresh the runtime started on its own failed, and who wants to hear about it. */
export class ReloadErrors {
	private message: string | undefined;
	private readonly listeners = new Set<(message: string) => void>();

	get current(): string | undefined {
		return this.message;
	}

	/** Records a failure (or, with `undefined`, a good reload) and tells each listener once per new message. */
	readonly set = (error: unknown): void => {
		const message = error === undefined ? undefined : error instanceof Error ? error.message : JSON.stringify(error);
		const changed = message !== this.message;
		this.message = message;
		if (!message || !changed) return;
		for (const listener of this.listeners) listener(message);
	};

	/** Calls `listener` once for each new failure (not again for the same message). Returns the unsubscribe. */
	subscribe(listener: (message: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	clearListeners(): void {
		this.listeners.clear();
	}
}
