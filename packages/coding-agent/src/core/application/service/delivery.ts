import type { ApplicationEvent, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { cloneDisplay } from "../normalize.ts";
import type { ApplicationStateStore } from "../state.ts";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../agent-session.ts";

/** Finish each mutation and its notifications before admitting work requested by an observer. */
export class ApplicationDelivery {
	private pending: (() => void)[] = [];
	private running = false;
	private readonly events = new Set<(event: ApplicationEvent) => void>();
	private readonly native = new Set<AgentSessionEventListener>();
	private readonly subscriptions = new Set<() => void>();
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
	runForSession(session: AgentSession, work: () => void): void {
		const sessionId = session.sessionId;
		const messages = session.messages;
		this.run(() => {
			if (sessionId === session.sessionId && messages === session.messages) work();
		});
	}
	subscribe(listener: (event: ApplicationEvent) => void): () => void {
		this.events.add(listener);
		return () => {
			this.events.delete(listener);
		};
	}
	subscribeNative(listener: AgentSessionEventListener): () => void {
		this.native.add(listener);
		return () => {
			this.native.delete(listener);
		};
	}
	notifyNative(event: AgentSessionEvent): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners added during dispatch start with the next event
		for (const listener of [...this.native]) {
			if (!this.native.has(listener)) continue;
			try {
				Promise.resolve(listener(event)).catch((error) => console.error("Application listener failed", error));
			} catch (error) {
				console.error("Application listener failed", error);
			}
		}
	}
	subscribeState(listener: (snapshot: ApplicationSnapshot) => void): () => void {
		let revision = this.state.getState().revision;
		const stop = this.state.subscribe((state) => {
			if (state.revision === revision) return;
			revision = state.revision;
			try {
				listener(this.snapshot());
			} catch (error) {
				console.error("Application state listener failed", error);
			}
		});
		const unsubscribe = () => {
			stop();
			this.subscriptions.delete(unsubscribe);
		};
		this.subscriptions.add(unsubscribe);
		return unsubscribe;
	}
	notify(event?: ApplicationEvent): void {
		const listeners = [...this.events];
		this.state.setState(({ revision }) => ({ revision: revision + 1 }));
		if (event)
			for (const listener of listeners) {
				if (!this.events.has(listener)) continue;
				try {
					listener(cloneDisplay(event));
				} catch (error) {
					console.error("Application listener failed", error);
				}
			}
	}
	close(): void {
		for (const unsubscribe of this.subscriptions) unsubscribe();
		this.events.clear();
		this.native.clear();
	}
}
