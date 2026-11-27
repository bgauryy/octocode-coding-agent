import { sourceOfEvent } from "../events/source.ts";
import type { PayloadEvent } from "../events/topics.ts";
import { describeEvent } from "./catalog.ts";
import { MAX_PENDING, PENDING_MAX_AGE_MS, type Pending } from "./gate-types.ts";

/** Events waiting for the next transcript row. Failed sends release their share of a line. */
export class PendingRows {
	private pending: Pending[] = [];
	private readonly now: () => number;

	constructor(now: () => number) {
		this.now = now;
	}

	record(event: PayloadEvent): Pending {
		const { label, key } = describeEvent(event);
		const same = this.pending.find((line) => line.key === key);
		if (same) {
			same.sends++;
			return same;
		}
		const origin = sourceOfEvent(event);
		const { kind, ...data } = event;
		const line = { kind, data, label, from: `${origin.kind} ${origin.id}`, key, at: this.now(), sends: 1 };
		this.pending.push(line);
		if (this.pending.length > MAX_PENDING) this.pending.shift();
		return line;
	}

	/** A send failed: its events no longer wake anything, so the next run is not shown as woken by them. */
	unlist(lines: readonly Pending[]): void {
		for (const line of lines) if (--line.sends <= 0) this.pending = this.pending.filter((each) => each !== line);
	}

	clear(): void {
		this.pending = [];
	}

	take() {
		const cutoff = this.now() - PENDING_MAX_AGE_MS;
		const lines = this.pending
			.filter((line) => line.at >= cutoff)
			.map(({ kind, label, from, data }) => ({ kind, label, from, data }));
		this.pending = [];
		return lines;
	}
}
