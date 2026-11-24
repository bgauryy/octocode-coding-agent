import type { Source } from "../events/source-types.ts";
import type { PayloadEvent as AgentEvent } from "../events/topics.ts";
import type { Message, SendOptions, SessionStop } from "./gate-types.ts";

/** An urgent send held until the stopped run settles. */
export interface HeldSend {
	events: readonly AgentEvent[];
	sources: readonly Source[];
	message: Message | ((stopped: boolean) => Message);
	options: SendOptions;
	done: { resolve: () => void; reject: (error: unknown) => void };
}

/** The same events as regular ones: the stop they asked for has been made. */
export const asRegular = (events: readonly AgentEvent[]): AgentEvent[] =>
	events.map((event) => (event.kind === "agent.message" ? { ...event, interrupt: false } : event));

/**
 * The stop an urgent send asks for, when no event loop is attached to make it: the session's own stop, the sends held
 * until the run it stopped has settled, and the signal that ends a wait at the end of that run.
 */
export class Interrupts {
	private session: SessionStop | undefined;
	private held: HeldSend[] = [];
	/** A step was running when the stop was asked for: only then do the held messages say one was stopped. */
	private ranStep = false;
	private waiting = new AbortController();

	/** The session whose run an urgent send may stop; the latest binding wins. */
	bind(session: SessionStop): void {
		this.session = session;
	}

	/** Whether the bound session is busy, so an urgent send has a run or a compaction to wait for. */
	busy(): boolean {
		return this.session !== undefined && !this.session.isIdle();
	}

	/** Whether the busy session has a run of its own (a session busy with a manual compaction has none). */
	running(): boolean {
		return this.session?.signal !== undefined;
	}

	/** Signalled while an urgent send waits for the run to stop. */
	get signal(): AbortSignal {
		return this.waiting.signal;
	}

	/** Marks that an urgent send is waiting for its stop, so a wait at the end of the run ends. */
	markWaiting(): void {
		this.waiting.abort();
	}

	/** Asks the session to stop; false when it cannot (the send then goes out as a waking message). */
	stop(): boolean {
		try {
			this.session?.abort("peer");
		} catch {
			return false;
		}
		return this.session !== undefined;
	}

	hold(send: HeldSend, running: boolean): void {
		this.held.push(send);
		this.ranStep ||= running;
		this.markWaiting();
	}

	/**
	 * Hands each held send to `deliver` in order, the last one asking for the turn the settle continues with; a throw keeps
	 * that send and the ones behind it for the next try. True when an urgent send stopped the run and nothing is held any
	 * more: also when the attached loop made the stop and holds the send itself, so the wait signal is reset either way.
	 */
	release(deliver: (send: HeldSend, stopped: boolean, last: boolean) => void): boolean {
		if (this.held.length === 0) {
			if (!this.waiting.signal.aborted) return false;
			this.clear();
			return true;
		}
		while (this.held.length > 0) {
			const send = this.held[0];
			try {
				deliver(send, this.ranStep, this.held.length === 1);
			} catch {
				return false;
			}
			this.held.shift();
		}
		this.clear();
		return true;
	}

	/** Forgets what is held (the session left): it was never sent. */
	clear(): void {
		this.held = [];
		this.ranStep = false;
		if (this.waiting.signal.aborted) this.waiting = new AbortController();
	}
}
