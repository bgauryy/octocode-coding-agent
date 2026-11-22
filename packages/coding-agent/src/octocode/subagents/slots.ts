import { maxSubagents } from "./concurrency.ts";

/** How long a start must still wait besides a slot (its provider cools down, `rate-gate.ts`); 0: it may start now. */
type Held = () => number;
const notHeld: Held = () => 0;

interface Waiter {
	grant: () => void;
	held: Held;
}

/**
 * Subagent slots under `maxSubagents()`. A call past the limit waits, first come first served, until a run gives its
 * slot back; its signal (Esc, a turn abort) gives up the wait. A slot is granted only to a start that `held` does not
 * hold, so one given back while the first waiter's provider cools down goes to the next waiter instead, and the held
 * one gets a slot when its hold ends: a child never starts straight into the throttle it waited behind.
 */
export class Slots {
	private taken = 0;
	private readonly waiting: Waiter[] = [];
	/** Looks again when the soonest hold of a waiter ends while slots are free. */
	private timer: ReturnType<typeof setTimeout> | undefined;

	private readonly limit: () => number;
	constructor(limit: () => number = maxSubagents) {
		this.limit = limit;
	}

	/** Takes a free slot without waiting; false when all are in use, a start that may go now already waits, or `held` holds this one. */
	tryTake(held: Held = notHeld): boolean {
		if (this.taken >= this.limit() || this.waiting.some((waiter) => waiter.held() <= 0) || held() > 0) return false;
		this.taken += 1;
		return true;
	}

	/** Takes a slot, waiting while all are in use or `held` holds it; `onWait` hears how many run when the wait begins. */
	async take(signal: AbortSignal | undefined, onWait?: (running: number) => void, held: Held = notHeld): Promise<void> {
		signal?.throwIfAborted();
		if (this.tryTake(held)) return;
		onWait?.(this.taken);
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				grant: () => {
					signal?.removeEventListener("abort", cancel);
					resolve();
				},
				held,
			};
			const cancel = () => {
				const index = this.waiting.indexOf(waiter);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(new Error("Cancelled while waiting for a subagent slot."));
			};
			this.waiting.push(waiter);
			signal?.addEventListener("abort", cancel, { once: true });
			// onWait may abort synchronously before the listener is installed.
			if (signal?.aborted) cancel();
			else this.grant();
		});
	}

	give(): void {
		this.taken = Math.max(0, this.taken - 1);
		this.grant();
	}

	/** Hands the free slots to the waiters no hold keeps, in arrival order; a held one is looked at again when its hold ends. */
	private grant(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		let soonest = Number.POSITIVE_INFINITY;
		for (let index = 0; index < this.waiting.length && this.taken < this.limit();) {
			const heldMs = this.waiting[index].held();
			if (heldMs > 0) {
				soonest = Math.min(soonest, heldMs);
				index += 1;
				continue;
			}
			const [next] = this.waiting.splice(index, 1);
			this.taken += 1;
			next.grant();
		}
		if (soonest === Number.POSITIVE_INFINITY || this.taken >= this.limit()) return;
		this.timer = setTimeout(() => this.grant(), soonest);
		this.timer.unref();
	}
}
