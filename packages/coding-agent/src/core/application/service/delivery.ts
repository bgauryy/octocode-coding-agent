import type { ApplicationEvent, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { cloneDisplay } from "../normalize.ts";
import type { ApplicationStateStore } from "../state.ts";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../agent-session/types.ts";
import type { ApplicationSession } from "../session-port.ts";

/** Where a subscriber's failure goes: its own handler (a terminal draws it in the transcript), else stderr. */
export type ListenerErrorHandler = (error: unknown) => void;

/** A failure of the service itself, not of a subscriber; a handler shows its message as it is. */
export class ApplicationServiceError extends Error {
	override name = "ApplicationServiceError";
}

interface Subscriber {
	report: ListenerErrorHandler;
	onError?: ListenerErrorHandler;
}

/**
 * Reports one subscriber's failures. Stderr is the fallback only for hosts without a handler (SDK, print mode): in the
 * terminal it would write over the screen. The same failure again (a subscriber that throws on every event) is reported
 * once, a failure raised while reporting is dropped, and a handler that throws falls back to stderr.
 */
function listenerFailureReporter(label: string, onError?: ListenerErrorHandler): ListenerErrorHandler {
	let last: string | undefined;
	let reporting = false;
	return (error) => {
		const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		if (reporting || key === last) return;
		last = key;
		reporting = true;
		try {
			if (onError) onError(error);
			else console.error(label, error);
		} catch (handlerError) {
			console.error(label, error, handlerError);
		} finally {
			reporting = false;
		}
	};
}

/** Finish each mutation and its notifications before admitting work requested by an observer. */
export class ApplicationDelivery {
	private pending: (() => void)[] = [];
	private running = false;
	private readonly events = new Map<(event: ApplicationEvent) => void, Subscriber>();
	private readonly native = new Map<AgentSessionEventListener, Subscriber>();
	/** State subscriptions by their unsubscribe function, with their own error handler. */
	private readonly subscriptions = new Map<() => void, ListenerErrorHandler | undefined>();
	private lastServiceFailure: string | undefined;
	private readonly state: ApplicationStateStore;
	private readonly snapshot: () => ApplicationSnapshot;
	constructor(state: ApplicationStateStore, snapshot: () => ApplicationSnapshot) {
		this.state = state;
		this.snapshot = snapshot;
	}
	run(work: () => void): void {
		this.pending.push(work);
		if (this.running) return;
		this.running = true;
		const errors: unknown[] = [];
		try {
			for (let index = 0; index < this.pending.length; index++) {
				try {
					this.pending[index]();
				} catch (error) {
					errors.push(error);
				}
			}
		} finally {
			this.pending = [];
			this.running = false;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Application delivery failed");
	}
	request<T>(work: () => T): Promise<T> {
		return new Promise((resolve, reject) => {
			this.run(() => {
				try {
					resolve(work());
				} catch (error) {
					reject(error);
				}
			});
		});
	}
	runForSession(session: Pick<ApplicationSession, "sessionId" | "messages">, work: () => void): void {
		const sessionId = session.sessionId;
		const messages = session.messages;
		this.run(() => {
			if (sessionId === session.sessionId && messages === session.messages) work();
		});
	}
	/**
	 * Report a service failure to every distinct subscriber handler, or to stderr when none has one (SDK, print mode).
	 * The same failure twice in a row (a store that keeps failing) is reported once.
	 */
	reportFailure(error: ApplicationServiceError): void {
		if (error.message === this.lastServiceFailure) return;
		this.lastServiceFailure = error.message;
		const handlers = new Set<ListenerErrorHandler>();
		for (const { onError } of [...this.events.values(), ...this.native.values()]) if (onError) handlers.add(onError);
		for (const onError of this.subscriptions.values()) if (onError) handlers.add(onError);
		if (handlers.size === 0) console.error(error.message, error.cause);
		for (const handler of handlers) {
			try {
				handler(error);
			} catch (handlerError) {
				console.error(error.message, error.cause, handlerError);
			}
		}
	}
	subscribe(listener: (event: ApplicationEvent) => void, onError?: ListenerErrorHandler): () => void {
		this.events.set(listener, { report: listenerFailureReporter("Application listener failed", onError), onError });
		return () => {
			this.events.delete(listener);
		};
	}
	subscribeNative(listener: AgentSessionEventListener, onError?: ListenerErrorHandler): () => void {
		this.native.set(listener, { report: listenerFailureReporter("Application listener failed", onError), onError });
		return () => {
			this.native.delete(listener);
		};
	}
	notifyNative(event: AgentSessionEvent): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners added during dispatch start with the next event
		for (const [listener, { report }] of [...this.native]) {
			if (!this.native.has(listener)) continue;
			try {
				Promise.resolve(listener(event)).catch(report);
			} catch (error) {
				report(error);
			}
		}
	}
	subscribeState(listener: (snapshot: ApplicationSnapshot) => void, onError?: ListenerErrorHandler): () => void {
		const report = listenerFailureReporter("Application state listener failed", onError);
		let revision = this.state.getState().revision;
		const stop = this.state.subscribe((state) => {
			if (state.revision === revision) return;
			revision = state.revision;
			try {
				listener(this.snapshot());
			} catch (error) {
				report(error);
			}
		});
		const unsubscribe = () => {
			stop();
			this.subscriptions.delete(unsubscribe);
		};
		this.subscriptions.set(unsubscribe, onError);
		return unsubscribe;
	}
	notify(event?: ApplicationEvent): void {
		const listeners = [...this.events];
		this.state.setState(({ revision }) => ({ revision: revision + 1 }));
		if (event)
			for (const [listener, { report }] of listeners) {
				if (!this.events.has(listener)) continue;
				try {
					listener(cloneDisplay(event));
				} catch (error) {
					report(error);
				}
			}
	}
	close(): void {
		// Deleting the visited entry during Map iteration is safe.
		for (const unsubscribe of this.subscriptions.keys()) unsubscribe();
		this.events.clear();
		this.native.clear();
	}
}
