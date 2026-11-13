import type { ApplicationConnection, ApplicationFrame, ApplicationPort } from "@octocodeai/octocode-contracts";

/** What a session list needs to know about a run: whether one is going, and the dialog it is blocked on. */
export interface SessionState {
	busy: boolean;
	/** The title of the open dialog, when the session waits for the user (a run, or a background subagent, is blocked on it). */
	needsYou?: string;
}

const RECONNECT_MS = 1000;
const TITLE_MAX = 300;

/**
 * Follows one attached session's application stream for the two facts the daemon's session list and `remote list` show:
 * `busy` (a run is in progress) and `needsYou` (the session is blocked on a dialog). One stream per attached session; a
 * resync or a dropped stream reconnects after a short wait while the session stays attached. `state` is undefined until
 * the first snapshot arrived, so a list never claims a session is idle before it heard from it.
 */
export class SessionWatch {
	state: SessionState | undefined;
	private connection: ApplicationConnection | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly port: ApplicationPort;
	private readonly sessionId: string;
	private readonly changed: () => void;

	constructor(port: ApplicationPort, sessionId: string, changed: () => void) {
		this.port = port;
		this.sessionId = sessionId;
		this.changed = changed;
		void this.follow();
	}

	private async follow(): Promise<void> {
		if (this.stopped) return;
		let connection: ApplicationConnection;
		try {
			connection = this.port.connect({ sessionId: this.sessionId });
		} catch {
			return this.later();
		}
		this.connection = connection;
		try {
			for await (const frame of connection) {
				if (this.stopped) break;
				this.apply(frame);
				if (frame.type === "resync") break;
			}
		} catch {
			// The stream ended with the attach connection; the registry drops this watch or it reconnects below.
		} finally {
			connection.close();
			if (this.connection === connection) this.connection = undefined;
			if (!this.stopped && this.state !== undefined) {
				this.state = undefined;
				this.changed();
			}
		}
		this.later();
	}

	private later(): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => void this.follow(), RECONNECT_MS);
		this.timer.unref();
	}

	private apply(frame: ApplicationFrame): void {
		const previous = this.state;
		// An open dialog with a title is a wait whether or not a run is going: a background subagent asks after its parent's
		// turn ended. A run's start or end leaves the dialog as it is; `session.awaiting` opens and closes it.
		const needs = (title: string | undefined) => (title ? { needsYou: title.slice(0, TITLE_MAX) } : {});
		if (frame.type === "snapshot") {
			this.state = { busy: frame.snapshot.streaming, ...needs(frame.snapshot.awaiting?.title) };
		} else if (frame.type === "event") {
			const event = frame.event;
			const kept = previous?.needsYou === undefined ? {} : { needsYou: previous.needsYou };
			if (event.type === "run.started") this.state = { busy: true, ...kept };
			else if (event.type === "run.settled") this.state = { busy: false, ...kept };
			else if (event.type === "session.awaiting" && previous)
				this.state = { busy: previous.busy, ...needs(event.awaiting?.title) };
		} else return;
		if (previous?.busy !== this.state?.busy || previous?.needsYou !== this.state?.needsYou) this.changed();
	}

	close(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.connection?.close();
		this.connection = undefined;
	}
}

/** Sessions that need the user first, then the ones working, then the rest; newest first within each group. */
export function byAttention<T extends { startedAt: number; busy?: boolean; needsYou?: string }>(a: T, b: T): number {
	const rank = (session: T) => (session.needsYou ? 0 : session.busy ? 1 : 2);
	return rank(a) - rank(b) || b.startedAt - a.startedAt;
}
