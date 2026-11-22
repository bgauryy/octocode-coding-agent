type RefreshProvider = (options: { allowNetwork: true; providers: string[]; signal: AbortSignal }) => Promise<unknown>;

/**
 * Starts a network model refresh of one provider after its credential changes. A new credential can list models the
 * old one could not (an account's plan, a custom host), and the startup refresh ran without it. At most one refresh
 * per provider runs at a time, and one already running covers the change. Disposing cancels what is running.
 */
export class CredentialNetworkRefresh {
	/** Set once the runtime knows whether the network may be used (not in offline mode, and requested). */
	enabled = false;
	private readonly running = new Set<string>();
	private readonly cancel = new AbortController();
	private readonly refresh: RefreshProvider;
	private readonly onError: (error: unknown) => void;

	constructor(refresh: RefreshProvider, onError: (error: unknown) => void) {
		this.refresh = refresh;
		this.onError = onError;
	}

	schedule(providerId: string): void {
		if (!this.enabled || this.cancel.signal.aborted || this.running.has(providerId)) return;
		this.running.add(providerId);
		void this.refresh({ allowNetwork: true, providers: [providerId], signal: this.cancel.signal })
			.catch((error: unknown) => {
				if (!this.cancel.signal.aborted) this.onError(error);
			})
			.finally(() => this.running.delete(providerId));
	}

	dispose(): void {
		this.cancel.abort();
	}
}
