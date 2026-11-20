import { dbStamp } from "../../../../db/src/api.ts";
import { onSecond } from "../shared/clock.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";

/** A tick this long after the previous one means the machine slept (or this process stalled): peers could not heartbeat either. */
const SUSPEND_GAP_MS = 15_000;

/** `poll` looks at the database file at most this often. */
const POLL_MS = 250;

/** What watchers (the agents panel) render: live agents, recent traffic, or why the team is off. */
export interface TeamView {
	members: Member[];
	traffic: Traffic[];
	error?: string;
	/** The error is transient (a locked or busy database): the next tick retries. Without it the team is off. */
	retrying?: boolean;
}

interface TickerSource {
	/** Whether the agent is joined: delivery and heartbeats need the ticker even with no watcher. */
	joined(): boolean;
	/** Delivery and heartbeat work, called on every tick. */
	beat(): void;
	/** The database file, or undefined when nobody created it yet (nothing to read). */
	dbFile(): string | undefined;
	/** One fresh read. */
	read(): TeamView;
	/** How long an unchanged snapshot may be reused; liveness is time-based, so re-read at this interval anyway. */
	maxAgeMs: number;
	/** The machine slept (or this process stalled) from `since` to `now`; called before that tick's beat. */
	resumed(since: number, now: number): void;
	/** Whether something follows the database for changes (the lifecycle bus): the ticker then runs even with no watcher. */
	following?(): boolean;
	/** The database file changed since the last tick that followed it; called at most once per change. */
	changed?(): void;
}

/**
 * The team's one ticker, on the shared one-second clock: it runs only while the agent is joined or something watches, beats for
 * delivery, and refreshes a cached view for watchers only when the database changed, so watchers never read it.
 */
export class TeamTicker {
	/** Stops the clock subscription; set while the ticker runs. */
	private stopClock: (() => void) | undefined;
	private readonly watchers = new Set<() => void>();
	private cached: TeamView = { members: [], traffic: [] };
	private stamp = "";
	/** The file stamp the follower last saw: `changed` runs when it moves. */
	private followed: string | undefined;
	private readAt = 0;
	private polledAt = 0;
	/** Wall time of the previous tick while the timer runs; 0 when it is stopped. */
	private tickedAt = 0;

	private readonly source: TickerSource;
	constructor(source: TickerSource) {
		this.source = source;
	}

	get view(): TeamView {
		return this.cached;
	}

	/** Call `listener` now and on every tick with a fresh `view`, until the returned function is called. */
	watch(listener: () => void): () => void {
		this.watchers.add(listener);
		this.refresh(true);
		this.sync();
		listener();
		return () => {
			this.watchers.delete(listener);
			this.sync();
		};
	}

	/**
	 * Between ticks: when a write moved the database file, refreshes the view and calls the watchers now, so a panel whose
	 * own clock runs (an agent works) follows a child's row within a fraction of a second. It starts no timer: the caller's
	 * clock drives it, and a stamp check is one stat at most every `POLL_MS`.
	 */
	poll(now: number = Date.now()): void {
		if (this.watchers.size === 0 || now - this.polledAt < POLL_MS) return;
		this.polledAt = now;
		const file = this.source.dbFile();
		if (!file || dbStamp(file) === this.stamp) return;
		this.refresh();
		for (const listener of this.watchers) listener();
	}

	/** Start or stop the timer to match whether there is any work. */
	sync(): void {
		const needed = this.source.joined() || this.watchers.size > 0 || this.source.following?.() === true;
		if (needed && !this.stopClock) {
			this.tickedAt = Date.now();
			this.stopClock = onSecond(() => this.tick());
		} else if (!needed && this.stopClock) {
			this.stopClock();
			this.stopClock = undefined;
			this.tickedAt = 0;
		}
	}

	reset(): void {
		this.cached = { members: [], traffic: [] };
		this.stamp = "";
	}

	private tick(): void {
		// Wall time jumped past the 1-second cadence: a timer cannot fire while the machine sleeps, so neither could any peer's.
		const now = Date.now();
		if (this.tickedAt > 0 && now - this.tickedAt > SUSPEND_GAP_MS) this.source.resumed(this.tickedAt, now);
		this.tickedAt = now;
		this.source.beat();
		this.follow();
		if (this.watchers.size === 0) return;
		this.refresh();
		for (const listener of this.watchers) listener();
	}

	/** One file stat per tick: the follower reads the database only when another write moved the stamp. */
	private follow(): void {
		if (this.source.following?.() !== true) {
			this.followed = undefined;
			return;
		}
		const file = this.source.dbFile();
		const stamp = file ? dbStamp(file) : "";
		if (stamp === this.followed) return;
		this.followed = stamp;
		this.source.changed?.();
	}

	private refresh(force = false): void {
		const file = this.source.dbFile();
		if (!file) {
			this.cached = this.source.read();
			return;
		}
		const stamp = dbStamp(file);
		const now = Date.now();
		// Retry failed reads; liveness and recent traffic also expire even without a database write.
		if (
			!force &&
			!this.cached.retrying &&
			stamp === this.stamp &&
			(now - this.readAt < this.source.maxAgeMs ||
				(this.cached.members.length === 0 && this.cached.traffic.length === 0))
		)
			return;
		this.cached = this.source.read();
		this.stamp = stamp;
		this.readAt = now;
	}
}
