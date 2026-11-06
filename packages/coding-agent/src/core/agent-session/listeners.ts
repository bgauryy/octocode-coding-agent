/** Event listeners of `AgentSession` and the promise `waitForIdle()` callers share. */

import type { AgentSessionEvent, AgentSessionEventListener } from "./types.ts";

export class SessionListeners {
	private _eventListeners: AgentSessionEventListener[] = [];
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Emit an event to all listeners */
	emit(event: AgentSessionEvent): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so listeners that unsubscribe during dispatch do not change iteration
		for (const l of [...this._eventListeners]) {
			l(event);
		}
	}

	/** Remove all listeners. */
	clear(): void {
		this._eventListeners = [];
	}

	/** The promise that resolves when the session next becomes idle. */
	idleWait(): Promise<void> {
		this._idleWaitPromise ??= new Promise((resolve) => {
			this._resolveIdleWait = resolve;
		});
		return this._idleWaitPromise;
	}

	/** Resolve a pending idle wait; the session calls this once it is idle. */
	resolveIdleWait(): void {
		if (!this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}
}
