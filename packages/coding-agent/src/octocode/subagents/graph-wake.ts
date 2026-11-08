import { WAKE_INTERVAL_MS, WakePace } from "../team/wake-pace.ts";

/** A notice waiting for the pace: `carried` when it rode in a report the model reads with any later turn. */
interface Held {
	notice: string;
	carried: boolean;
}

/**
 * Wakes the coordinator for the coordination graph (`backlog/graph-notice.ts`): a child's report that says what became
 * ready, or what waits on an item the child left open, wakes an idle coordinator even when the report alone would not (a
 * stop the user asked for, a report it already read), and so does a prerequisite completed outside this process
 * (`graph-watch.ts`), so the graph never stalls. Those extra wakes share the team's `WakePace` with peer mail: one refused
 * now is sent later as its own message, once the pace allows. A deferral, not a deadline.
 */
export class GraphWake {
	private readonly notices = new Map<string, string>();
	/** Runs stopped by stopping every child (plan mode, leaving, reload, shutdown): their reports force no wake. */
	private readonly quiet = new Set<string>();
	private readonly held: Held[] = [];
	private retry: NodeJS.Timeout | undefined;
	private running = true;

	private readonly send: (content: string) => void;
	private readonly idle: () => boolean;
	private readonly pace: WakePace;
	private readonly retryMs: number;
	constructor(
		send: (content: string) => void,
		idle: () => boolean = () => true,
		pace = new WakePace(),
		retryMs = WAKE_INTERVAL_MS,
	) {
		this.send = send;
		this.idle = idle;
		this.pace = pace;
		this.retryMs = retryMs;
	}

	/** A session started again after `stop`: graph notices may wake it. */
	start(): void {
		this.running = true;
	}

	/** The session is ending: its reports are saved for the next start, so nothing forces a wake now or later. */
	stop(): void {
		this.running = false;
		clearTimeout(this.retry);
		this.retry = undefined;
		this.notices.clear();
		this.quiet.clear();
		this.held.length = 0;
		this.pace.reset();
	}

	/** The session stops these runs itself, all at once: their reports, whenever they arrive, force no wake. */
	stopping(ids: Iterable<string>): void {
		for (const id of ids) this.quiet.add(id);
	}

	/** A coordinator turn started: it reads every report already sent, so the notices those carried need no wake of their own. */
	turnStarted(): void {
		const kept = this.held.filter((entry) => !entry.carried);
		this.held.splice(0, this.held.length, ...kept);
	}

	/** The report of run `id` carries graph notice `notice`. */
	mark(id: string, notice: string): void {
		this.notices.set(id, notice);
	}

	/** Whether the report of run `id` wakes the coordinator: `waking` already, or it carries a graph notice the pace admits. */
	wakes(id: string, waking: boolean): boolean {
		const notice = this.notices.get(id);
		this.notices.delete(id);
		const quiet = this.quiet.delete(id);
		if (waking || notice === undefined || quiet || !this.running) return waking;
		return this.admit({ notice, carried: true });
	}

	/** A graph notice no report carries (a change made outside this process): sent now when the pace allows, else later. */
	tell(notice: string): void {
		if (this.running && this.admit({ notice, carried: false })) this.send(notice);
	}

	/**
	 * Whether `entry` may wake the coordinator now. A busy coordinator reads it at the end of its turn, which spends no pace;
	 * an idle one is woken when the pace allows, and otherwise the notice waits for it.
	 */
	private admit(entry: Held): boolean {
		if (!this.idle()) return true;
		if (this.pace.allows()) {
			this.pace.record();
			return true;
		}
		this.held.push(entry);
		this.later();
		return false;
	}

	/** Sends the held notices as one waking message once the pace allows. */
	private later(): void {
		if (this.retry) return;
		this.retry = setTimeout(() => {
			this.retry = undefined;
			if (!this.running || this.held.length === 0) return;
			const idle = this.idle();
			if (idle && !this.pace.allows()) return this.later();
			if (idle) this.pace.record();
			this.send(
				this.held
					.splice(0)
					.map((entry) => entry.notice)
					.join("\n"),
			);
		}, this.retryMs);
		this.retry.unref?.();
	}
}
