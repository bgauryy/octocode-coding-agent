import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";

const LIVENESS_MS = 2000;

/** A cached board's process liveness and idle boundaries can change without a database write. */
export class BacklogProjection {
	private value: Snapshot | undefined;
	private owners = new Map<string, boolean>();
	private nextProbe = 0;
	private nextIdle = Infinity;
	private readonly load: (now: number) => Snapshot;
	private readonly lives: (id: string) => boolean;
	private readonly self: string | undefined;

	constructor(load: (now: number) => Snapshot, lives: (id: string) => boolean, self?: string) {
		this.load = load;
		this.lives = lives;
		this.self = self;
	}

	/** Release retained board text when its last reader leaves. */
	clear(): void {
		this.value = undefined;
		this.owners.clear();
		this.nextIdle = Infinity;
	}

	/** Rebuild after a database change or for a newly connected reader. */
	read(now = Date.now()): Snapshot {
		const value = this.load(now);
		this.value = value;
		this.owners = new Map();
		for (const item of value.items) if (item.assignee) this.owners.set(item.assignee, Boolean(item.assigneeLive));
		this.nextProbe = now + LIVENESS_MS;
		this.nextIdle = this.idleBoundary(value, now);
		return value;
	}

	/** Reuse the board and its text; emit only when a live owner or an idle classification changed. */
	refresh(now = Date.now()): Snapshot | undefined {
		const previous = this.value;
		if (!previous) return undefined;
		let changed = false;
		if (now >= this.nextProbe) {
			this.nextProbe = now + LIVENESS_MS;
			for (const [id, before] of this.owners) {
				const after = id === this.self || this.lives(id);
				if (before !== after) changed = true;
				this.owners.set(id, after);
			}
		}
		const idle = now >= this.nextIdle;
		if (!changed && !idle) return undefined;
		const items = changed
			? previous.items.map((item) => (item.assignee ? { ...item, assigneeLive: this.owners.get(item.assignee) } : item))
			: previous.items;
		this.value = { ...previous, generatedAt: Math.max(now, previous.generatedAt + 1), items };
		if (idle) this.nextIdle = this.idleBoundary(this.value, now);
		return this.value;
	}

	private idleBoundary(value: Snapshot, now: number): number {
		let next = Infinity;
		for (const item of value.items) {
			const at = item.updatedAt + value.idleMs + 1;
			if (item.state !== "done" && at > now) next = Math.min(next, at);
		}
		return next;
	}
}
