import {
	type Activity,
	type ApplicationConnection,
	type ApplicationFrame,
	type ApplicationPort,
	type ApplicationSnapshot,
	isPendingApplicationPhase,
} from "@octocodeai/octocode-contracts";
import { activity } from "@octocodeai/octocode-projections";

/** What a session list needs to know about a session: whether it is working, the dialog it is blocked on, and its light. */
export interface SessionState {
	/** A run is going, or the job waits on its background agents, jobs, a wake or a timer: the session is not done. */
	busy: boolean;
	/** The title of the open dialog, when the session waits for the user (a run, or a background subagent, is blocked on it). */
	needsYou?: string;
	/** The light every surface shows for these facts (`activity`): failed, stopped, compacting and retrying included. */
	activity: Activity;
}

/** The snapshot facts the light reads, kept from the snapshot and updated by the events that change them. */
type Facts = Partial<Pick<ApplicationSnapshot, "streaming" | "status" | "awaiting" | "phase">>;

const RECONNECT_MS = 1000;
/** The longest wait between attempts while each one fails. */
const RECONNECT_MAX_MS = 60_000;
const TITLE_MAX = 300;

/**
 * Follows one attached session's application stream for what the daemon's session list and `remote list` show: `busy` (a
 * run is in progress, or the session's phase still waits on background work), `needsYou` (the session is blocked on a
 * dialog) and `activity`, the shared light of the snapshot facts it keeps (`streaming`, `status`, `awaiting`, `phase`).
 * One stream per attached session; a
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
	/** The snapshot's facts as the stream has changed them since; `busy`, `needsYou` and `activity` are read from them. */
	private facts: Facts = {};
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
		if (frame.type === "snapshot") {
			const { streaming, status, awaiting, phase } = frame.snapshot;
			this.facts = { streaming, status, awaiting, phase };
		} else if (frame.type === "event") {
			if (!previous) return;
			// A run's start or end leaves the dialog as it is; `session.awaiting` opens and closes it.
			const event = frame.event;
			if (event.type === "run.started") this.facts.streaming = true;
			else if (event.type === "run.settled") this.facts.streaming = false;
			else if (event.type === "session.phase") this.facts.phase = event.phase;
			else if (event.type === "session.status") this.facts.status = event.status;
			else if (event.type === "session.awaiting") this.facts.awaiting = event.awaiting;
			else return;
		} else return;
		const { streaming, phase, awaiting } = this.facts;
		// An open dialog with a title is a wait whether or not a run is going: a background subagent asks after its parent's
		// turn ended.
		const title = awaiting?.title?.slice(0, TITLE_MAX);
		this.state = {
			busy: Boolean(streaming) || (phase !== undefined && isPendingApplicationPhase(phase)),
			...(title ? { needsYou: title } : {}),
			activity: activity(this.facts),
		};
		const shown = (state: SessionState | undefined) =>
			state && `${state.busy}\0${state.needsYou ?? ""}\0${state.activity.tone}\0${state.activity.label}`;
		if (shown(previous) !== shown(this.state)) this.changed();
	}

	close(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.connection?.close();
		this.connection = undefined;
	}
}

/** The rank of each light in a list: the user's attention first, then work, then a failure, then rest. */
const RANK: Record<Activity["tone"], number> = { waiting: 0, working: 1, error: 2, idle: 3 };

/**
 * Sessions that need the user first, then the ones working, then the failed ones, then the rest; newest first within each.
 * A row without a light (the daemon has not seen its state yet) ranks by `needsYou` and `busy`.
 */
export function byAttention<T extends { startedAt: number; busy?: boolean; needsYou?: string; activity?: Activity }>(
	a: T,
	b: T,
): number {
	const rank = (session: T) =>
		session.activity ? RANK[session.activity.tone] : session.needsYou ? 0 : session.busy ? 1 : 3;
	return rank(a) - rank(b) || b.startedAt - a.startedAt;
}
