import type { DatabaseSync } from "node:sqlite";
import * as maintenance from "../queries/maintenance.ts";

/** Commands a busy writer runs between two PASSIVE checkpoints of its file. */
const PASSIVE_EVERY = 64;
/** How long the queue stays empty before the writer tries a TRUNCATE checkpoint. */
const IDLE_FIRST_MS = 250;
/** The longest wait between TRUNCATE attempts while a reader keeps one from finishing; each busy attempt doubles the wait. */
const IDLE_MAX_MS = 30_000;

/**
 * A writer's checkpoints of the file it owns. SQLite's own checkpoint (PASSIVE, at 1000 WAL pages, by whichever
 * connection commits) cannot pass a reader's snapshot and never shrinks the WAL file, so long-lived readers let it grow
 * and stay grown. While commands run, the writer checkpoints PASSIVE every `PASSIVE_EVERY` commands; once its queue is
 * empty it tries TRUNCATE, which resets the WAL to zero bytes when no reader still needs it, never waiting for a lock.
 * A reader in the way only postpones the next attempt (backing off up to `IDLE_MAX_MS`); the next command cancels it.
 * Nothing waits for a checkpoint, and none is ever required: each one is maintenance, retried while the writer lives.
 */
export class CheckpointDuty {
	private since = 0;
	private wait = IDLE_FIRST_MS;
	private timer: NodeJS.Timeout | undefined;
	private readonly db: () => DatabaseSync | undefined;

	/** `db` is the connection on the writer's own file, or undefined while it cannot open. */
	constructor(db: () => DatabaseSync | undefined) {
		this.db = db;
	}

	/** A command is about to run: the idle attempt waits for the next quiet spell. */
	busy(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.wait = IDLE_FIRST_MS;
	}

	/** A command committed (or found nothing to do). */
	ran(): void {
		this.since += 1;
		if (this.since < PASSIVE_EVERY) return;
		this.since = 0;
		this.attempt(() => maintenance.passiveCheckpoint(this.connection()));
	}

	/** The queue is empty: try TRUNCATE after a quiet spell, and again later while a reader keeps it from finishing. */
	idle(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const done = this.attempt(() => !maintenance.checkpoint(this.connection(), 0).busy);
			if (done) {
				this.wait = IDLE_FIRST_MS;
				return;
			}
			this.wait = Math.min(this.wait * 2, IDLE_MAX_MS);
			this.idle();
		}, this.wait);
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private connection(): DatabaseSync {
		const db = this.db();
		if (!db?.isOpen) throw new Error("no connection");
		return db;
	}

	/** Runs one checkpoint; a failure (no connection yet, another process's lock) counts as not done. */
	private attempt(run: () => unknown): boolean {
		try {
			return run() !== false;
		} catch {
			return false;
		}
	}
}
