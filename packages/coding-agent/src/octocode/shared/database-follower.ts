import { onSecond } from "./clock.ts";

/**
 * One follower of the shared database file for every wait on something other processes write: a timer (a lease released,
 * a backlog item moved, an agent ended) or the coordination-graph watch (`subagents/graph-watch.ts`). It reads the file's
 * change marker (`dbStamp`) on the shared clock, only while a wait listens, and pokes the listeners when it moved: a hint
 * to check now, never the answer. A scheduler calls `rebase` after its own writes so they do not poke it back. A poke
 * that meets another process's lock (the busy error, raised by a read made without waiting) is asked again on the next
 * tick, whether or not the file moves again.
 */
export class DatabaseFollower {
	private readonly listeners = new Set<() => void>();
	private readonly stamp: () => string;
	private last: string | undefined = "";
	private stop: (() => void) | undefined;

	private readonly busy: (error: unknown) => boolean;

	/** `busy` tells another process's lock (the database's busy error) from a failure, which propagates. */
	constructor(stamp: () => string, busy: (error: unknown) => boolean) {
		this.stamp = stamp;
		this.busy = busy;
	}

	get listening(): number {
		return this.listeners.size;
	}

	/** `initial`: the listener is also asked at the next tick, whether or not the file moves, for a change since it last looked. */
	subscribe(poke: () => void, { initial = false } = {}): () => void {
		this.listeners.add(poke);
		if (!this.stop) {
			this.last = this.stamp();
			this.stop = onSecond(() => this.tick());
		}
		if (initial) this.last = undefined;
		return () => {
			this.listeners.delete(poke);
			if (this.listeners.size === 0) {
				this.stop?.();
				this.stop = undefined;
			}
		};
	}

	/** Takes the file's current marker as seen: this process wrote it. */
	rebase(): void {
		if (this.stop) this.last = this.stamp();
	}

	private tick(): void {
		const next = this.stamp();
		if (next === this.last) return;
		this.last = next;
		let locked = false;
		for (const poke of this.listeners) {
			try {
				poke();
			} catch (error) {
				if (!this.busy(error)) throw error;
				locked = true;
			}
		}
		if (locked) this.last = undefined;
	}
}
