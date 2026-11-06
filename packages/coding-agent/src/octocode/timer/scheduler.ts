import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import { onSecond } from "../shared/clock.ts";
import { type CheckOutcome, type TimerCondition, decideFire, rowCondition } from "./model.ts";

export interface SchedulerDeps {
	db: () => AgentDb;
	sessionId: string;
	now?: () => number;
	/** Checks an `until` row's condition in its working directory. */
	check(condition: TimerCondition, cwd: string): Promise<CheckOutcome>;
	/** Delivers a wake: the row after its fire, ended or still active. */
	wake(row: TimerRow): void;
	/** The number of active timers after any change, for the footer. */
	changed?(active: number): void;
	/** A failed pass (an unreadable database): the timers stay in the database and the next tick tries again. */
	failed?(error: unknown): void;
}

/**
 * Fires one session's timers from the agent database. It keeps only the next due time in memory and ticks on the shared
 * clock while any timer is active; at the due time it reads the due rows and claims each with one guarded statement
 * (`timers.claim`), so a second process on the same session never fires a row twice, and runs missed while no process
 * held the session coalesce into one fire.
 */
export class TimerScheduler {
	private readonly deps: SchedulerDeps;
	private readonly now: () => number;
	private next: number | undefined;
	private unsubscribe: (() => void) | undefined;
	private pass: Promise<void> | undefined;
	private waiters: Array<() => void> = [];
	/** Timers this process set during the session: only these hold a headless run's exit (`settle`). */
	private readonly held = new Set<number>();
	private stopped = false;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	get sessionId(): string {
		return this.deps.sessionId;
	}

	/** Marks a timer this process just set: a headless run waits for its wakes while it stays active. */
	hold(id: number): void {
		this.held.add(id);
	}

	/** Rereads the next due time after a change (load, set, cancel, a fire) and ticks only while one exists. */
	refresh(): void {
		if (this.stopped) return;
		const db = this.deps.db().db;
		this.next = timers.nextDue(db, this.deps.sessionId);
		for (const id of this.held) if (timers.get(db, id)?.status !== "active") this.held.delete(id);
		if (this.held.size === 0) this.release();
		if (this.next === undefined) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		} else
			this.unsubscribe ??= onSecond(() => {
				void this.tick();
			});
		this.deps.changed?.(timers.activeCount(db, this.deps.sessionId));
	}

	/** Fires what is due; a pass already running is joined, not repeated. */
	tick(): Promise<void> {
		if (this.stopped || this.next === undefined || this.now() < this.next) return this.pass ?? Promise.resolve();
		this.pass ??= this.fireDue()
			.catch((error: unknown) => this.deps.failed?.(error))
			.finally(() => {
				this.pass = undefined;
				if (!this.stopped) {
					try {
						this.refresh();
					} catch (error) {
						this.deps.failed?.(error);
					}
				}
			});
		return this.pass;
	}

	/**
	 * A headless run's hold: while a timer this process set (`hold`) is active, resolves at the session's next wake or when
	 * the last such timer ends or is cancelled; otherwise at once. Timers loaded at start, set by an earlier run, never hold
	 * an exit: they wake the session when it is resumed.
	 */
	settle(): Promise<void> {
		if (this.stopped || this.next === undefined || this.held.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Stops ticking; the rows stay active for a resumed session. */
	stop(): void {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.release();
	}

	private release(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	private async fireDue(): Promise<void> {
		const db = this.deps.db().db;
		for (const due of timers.due(db, this.deps.sessionId, this.now())) {
			if (this.stopped) return;
			const claimed = timers.claim(db, due.id, this.deps.sessionId, this.now());
			if (claimed) await this.fire(claimed);
		}
	}

	private async fire(claimed: TimerRow): Promise<void> {
		const db = this.deps.db().db;
		let row = claimed;
		let check: CheckOutcome | undefined;
		const condition = rowCondition(row);
		if (row.kind === "until" && condition) {
			check = await this.deps.check(condition, row.cwd ?? process.cwd());
			timers.recordResult(db, row.id, { exit: check.exit, output: check.output }, this.now());
			row = timers.get(db, row.id) ?? row;
		}
		if (this.stopped) return;
		const decision = decideFire(row, check);
		if (decision.end) {
			const ended = timers.finish(db, row.id, decision.end.status, decision.end.reason, this.now());
			// Cancelled while its check ran: the cancel wins and nobody is woken.
			if (!ended) return;
			row = ended;
		} else if (row.status !== "active" && row.kind !== "once") return;
		if (!decision.wake) return;
		this.deps.wake(row);
		this.release();
	}
}
