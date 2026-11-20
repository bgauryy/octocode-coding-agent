import {
	type ApplicationConnection,
	type ApplicationFrame,
	type ApplicationPhase,
	type ApplicationPort,
	isPendingApplicationPhase,
} from "@octocodeai/octocode-contracts";

/** What a session list needs to know about a session: whether it is working, and the dialog it is blocked on. */
export interface SessionState {
	/** A run is going, or the job waits on its background agents, jobs, a wake or a timer: the session is not done. */
	busy: boolean;
	/** The title of the open dialog, when the session waits for the user (a run, or a background subagent, is blocked on it). */
	needsYou?: string;
}

const RECONNECT_MS = 1000;
/** The longest wait between attempts while each one fails. */
const RECONNECT_MAX_MS = 60_000;
const TITLE_MAX = 300;

/**
 * Follows one attached session's application stream for the two facts the daemon's session list and `remote list` show:
 * `busy` (a run is in progress, or the session's phase still waits on background work) and `needsYou` (the session is blocked on a dialog). One stream per attached session; a
 * resync or a dropped stream reconnects after a short wait while the session stays attached; while attempts keep failing
 * the wait doubles, up to a minute, and a failure that repeats is reported once. `state` is undefined until the first
 * snapshot arrived, so a list never claims a session is idle before it heard from it.
 */
export class SessionWatch {
	state: SessionState | undefined;
	private connection: ApplicationConnection | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly port: ApplicationPort;
	private readonly sessionId: string;
	private readonly changed: () => void;
	/** The two facts `busy` combines: a run is going, and the phase waits on work that continues the job. */
	private running = false;
	private waiting = false;
	/** Attempts that failed in a row, and the last failure reported; a stream that ends normally clears both. */
	private failures = 0;
	private reported: string | undefined;

	/** Where a throw goes: by default a rejection the daemon's `unhandledRejection` guard logs to `web/daemon.log`. */
	private readonly report: (error: unknown) => void;

	constructor(
		port: ApplicationPort,
		sessionId: string,
		changed: () => void,
		report: (error: unknown) => void = (error) => void Promise.reject(error),
	) {
		this.port = port;
		this.sessionId = sessionId;
		this.changed = changed;
		this.report = report;
		this.start();
	}

	/** Follows the session. A throw (a frame `apply` cannot read, a broken stream) still reconnects, later each time. */
	private start(): void {
		this.follow().catch((error: unknown) => {
			this.failed();
			const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			if (text === this.reported) return;
			this.reported = text;
			this.report(error);
		});
	}

	private async follow(): Promise<void> {
		if (this.stopped) return;
		let connection: ApplicationConnection;
		try {
			connection = this.port.connect({ sessionId: this.sessionId });
		} catch {
			// The session cannot take a connection now (it is closing or not attached yet): try again later.
			return this.failed();
		}
		this.connection = connection;
		try {
			for await (const frame of connection) {
				if (this.stopped) break;
				this.apply(frame);
				if (frame.type === "resync") break;
			}
			// A closed or dropped connection ends the stream by returning, so the loop above exits normally and the watch
			// reconnects below; a throw propagates to `start`.
		} finally {
			connection.close();
			if (this.connection === connection) this.connection = undefined;
			if (!this.stopped && this.state !== undefined) {
				this.state = undefined;
				this.changed();
			}
		}
		this.failures = 0;
		this.reported = undefined;
		this.later(RECONNECT_MS);
	}

	private failed(): void {
		this.failures++;
		this.later(Math.min(RECONNECT_MS * 2 ** (this.failures - 1), RECONNECT_MAX_MS));
	}

	private later(delayMs: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => this.start(), delayMs);
		this.timer.unref();
	}

	private apply(frame: ApplicationFrame): void {
		const previous = this.state;
		// An open dialog with a title is a wait whether or not a run is going: a background subagent asks after its parent's
		// turn ended. A run's start or end leaves the dialog as it is; `session.awaiting` opens and closes it.
		const needs = (title: string | undefined) => (title ? { needsYou: title.slice(0, TITLE_MAX) } : {});
		const pending = (phase: ApplicationPhase | undefined) => phase !== undefined && isPendingApplicationPhase(phase);
		if (frame.type === "snapshot") {
			this.running = frame.snapshot.streaming;
			this.waiting = pending(frame.snapshot.phase);
			this.state = { busy: this.running || this.waiting, ...needs(frame.snapshot.awaiting?.title) };
		} else if (frame.type === "event") {
			if (!previous) return;
			const event = frame.event;
			let needsYou = previous.needsYou;
			if (event.type === "run.started") this.running = true;
			else if (event.type === "run.settled") this.running = false;
			else if (event.type === "session.phase") this.waiting = pending(event.phase);
			else if (event.type === "session.awaiting") needsYou = needs(event.awaiting?.title).needsYou;
			else return;
			this.state = { busy: this.running || this.waiting, ...(needsYou === undefined ? {} : { needsYou }) };
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
