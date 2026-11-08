import { onSecond } from "./clock.ts";

/**
 * One follower of the shared database file for every wait on something other processes write: a timer (a lease released,
 * a backlog item moved, an agent ended) or the coordination-graph watch (`subagents/graph-watch.ts`). It reads the file's
 * change marker (`dbStamp`) on the shared clock, only while a wait listens, and pokes the listeners when it moved: a hint
 * to check now, never the answer. A scheduler calls `rebase` after its own writes so they do not poke it back.
 */
export class DatabaseFollower {
	private readonly listeners = new Set<() => void>();
	private readonly stamp: () => string;
	private last = "";
	private stop: (() => void) | undefined;

	constructor(stamp: () => string) {
		this.stamp = stamp;
	}

	get listening(): number {
		return this.listeners.size;
	}

	subscribe(poke: () => void): () => void {
		this.listeners.add(poke);
		if (!this.stop) {
			this.last = this.stamp();
			this.stop = onSecond(() => this.tick());
		}
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
		for (const poke of this.listeners) poke();
	}
}
