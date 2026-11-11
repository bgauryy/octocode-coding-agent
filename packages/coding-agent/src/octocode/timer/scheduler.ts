import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import { onSecond } from "../shared/clock.ts";
import type { CheckInput } from "./condition.ts";
import { conditionTiming } from "./conditions/index.ts";
import { type CheckOutcome, type TimerCondition, decideFire, rowCondition, rowRemoved } from "./model.ts";

/** Events for one path arrive in bursts (a build writing files): one check follows the last event after this long. */
const POKE_DEBOUNCE_MS = 150;
/** A watcher that failed (NFS, a missing directory, no inotify watches) is tried again after this long; polling covers the gap. */
const WATCH_RETRY_MS = 5000;

export interface SchedulerDeps {
	db: () => AgentDb;
	sessionId: string;
	now?: () => number;
	/** Checks an `until` row's condition in its working directory. */
	check(condition: TimerCondition, input: CheckInput): Promise<CheckOutcome>;
	/** An event source for a condition: calls `poke` to say "check now" and `failed` when it stops working; returns the unsubscribe. */
	watch?(condition: TimerCondition, cwd: string, poke: () => void, failed: () => void): () => void;
	/** Called after this scheduler wrote: a follower of the database file must not read the write as someone else's. */
	wrote?(): void;
	/** A timer ended or was cancelled: drop what is kept for it. */
	forget?(id: number): void;
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
	private readonly watchers = new Map<number, { stop: () => void; live: boolean; retryAt: number }>();
	/** The active `until` rows as of the last sync: a row that left it has ended, and what is kept for it goes. */
	private seen = new Set<number>();
	private readonly pokes = new Map<number, ReturnType<typeof setTimeout>>();
	/** Rows being checked now, by a tick or a poke: a second check of the same row waits for the next trigger. */
	private readonly checking = new Set<number>();

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
		this.syncWatchers();
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

	/** Stops ticking and watching; the rows stay active for a resumed session. */
	stop(): void {
		this.stopped = true;
		for (const id of this.watchers.keys()) this.unwatch(id);
		for (const handle of this.pokes.values()) clearTimeout(handle);
		this.pokes.clear();
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
			if (this.checking.has(due.id)) continue;
			const claimed = timers.claim(db, due.id, this.deps.sessionId, this.now());
			this.deps.wrote?.();
			if (claimed) await this.guarded(claimed.id, () => this.fire(claimed));
		}
	}

	private async guarded(id: number, run: () => Promise<void>): Promise<void> {
		this.checking.add(id);
		try {
			await run();
		} finally {
			this.checking.delete(id);
		}
	}

	/** Starts an event source for each active watched row that has none, and stops those of rows that ended. */
	private syncWatchers(): void {
		const { watch } = this.deps;
		const db = this.deps.db().db;
		const active = new Map(timers.activeUntil(db, this.deps.sessionId).map((row) => [row.id, row]));
		for (const id of this.seen) if (!active.has(id)) this.unwatch(id);
		this.seen = new Set(active.keys());
		if (!watch) return;
		for (const row of active.values()) {
			const condition = rowCondition(row);
			const held = this.watchers.get(row.id);
			if (!condition || !conditionTiming(condition).watched || held?.live) continue;
			if (held && this.now() < held.retryAt) continue;
			held?.stop();
			const entry = { stop: (): void => undefined, live: true, retryAt: 0 };
			this.watchers.set(row.id, entry);
			const failed = () => {
				entry.live = false;
				entry.retryAt = this.now() + WATCH_RETRY_MS;
				// Polling covers a dead event source: bring the next check forward to the no-event interval.
				if (!this.stopped) timers.reschedule(this.deps.db().db, row.id, this.now() + conditionTiming(condition).pollMs);
			};
			try {
				entry.stop = watch(condition, row.cwd ?? process.cwd(), () => this.poke(row.id), failed);
			} catch (error) {
				failed();
				this.deps.failed?.(error);
			}
		}
	}

	private unwatch(id: number): void {
		this.watchers.get(id)?.stop();
		this.watchers.delete(id);
		const handle = this.pokes.get(id);
		if (handle) clearTimeout(handle);
		this.pokes.delete(id);
		this.deps.forget?.(id);
	}

	/** An event source saw something: one check after the burst settles, ahead of the due time. */
	private poke(id: number): void {
		if (this.stopped || this.pokes.has(id)) return;
		this.pokes.set(
			id,
			setTimeout(() => {
				this.pokes.delete(id);
				void this.pokeNow(id)
					.catch((error: unknown) => this.deps.failed?.(error))
					.finally(() => {
						if (this.stopped) return;
						try {
							this.refresh();
						} catch (error) {
							this.deps.failed?.(error);
						}
					});
			}, POKE_DEBOUNCE_MS),
		);
	}

	/**
	 * Checks a row now. A check that finds nothing writes nothing (a shared database changes often, so a quiet check must be
	 * cheap); one that is met, refused or spent money claims the row and goes through the same `fire` a due tick does.
	 */
	private async pokeNow(id: number): Promise<void> {
		if (this.stopped || this.checking.has(id)) return;
		const db = this.deps.db().db;
		const row = timers.get(db, id);
		const condition = row && rowCondition(row);
		if (!row || row.status !== "active" || !condition) return;
		await this.guarded(id, async () => {
			const outcome = await this.deps.check(condition, this.input(row));
			if (this.stopped || (!outcome.met && !outcome.refused && !outcome.spend)) return;
			const claimed = timers.claimNow(db, id, this.deps.sessionId, this.now());
			this.deps.wrote?.();
			if (claimed) await this.fire(claimed, outcome);
		});
	}

	private input(row: TimerRow): CheckInput {
		return {
			cwd: row.cwd ?? process.cwd(),
			row: { id: row.id, checks: row.checks, spentUsd: row.spent_usd, sessionId: row.session_id },
		};
	}

	private async fire(claimed: TimerRow, checked?: CheckOutcome): Promise<void> {
		const db = this.deps.db().db;
		let row = claimed;
		let check = checked;
		const condition = rowCondition(row);
		if (row.kind === "until" && condition) {
			check ??= await this.deps.check(condition, this.input(row));
			timers.recordResult(
				db,
				row.id,
				{ exit: check.exit, output: check.output, ...(check.spend ? { spend: check.spend } : {}) },
				this.now(),
			);
			this.deps.wrote?.();
			row = timers.get(db, row.id) ?? row;
		} else {
			// A row stored with a condition kind this version removed: it ends now, with the way to set it again.
			const removed = rowRemoved(row);
			if (removed) check = { met: false, exit: null, output: "", refused: removed };
		}
		if (this.stopped) return;
		const decision = decideFire(row, check);
		if (decision.end) {
			const ended = timers.finish(db, row.id, decision.end.status, decision.end.reason, this.now());
			this.deps.wrote?.();
			// Cancelled while its check ran: the cancel wins and nobody is woken.
			if (!ended) return;
			row = ended;
		} else if (row.status !== "active" && row.kind !== "once") return;
		if (!decision.wake) {
			const held = this.watchers.get(row.id);
			if (condition && conditionTiming(condition).watched && held && !held.live)
				timers.reschedule(db, row.id, this.now() + conditionTiming(condition).pollMs);
			return;
		}
		this.deps.wake(row);
		this.release();
	}
}
