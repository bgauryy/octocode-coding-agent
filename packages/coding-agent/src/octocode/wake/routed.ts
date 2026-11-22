import type { Source } from "../events/source-types.ts";
import type { PayloadEvent } from "../events/topics.ts";
import type { GateRoute, Held } from "./gate-types.ts";

/** The sends the live loop holds for the gate (`runtime.eventLoop: new`) and the intake that takes them. */
export class Routed {
	private route: GateRoute | undefined;
	private readonly held = new Set<Held>();

	/** Attaches the live loop's intake; `undefined` returns cut-over topics to the gate. */
	set(route: GateRoute | undefined): void {
		this.route = route;
	}

	get active(): boolean {
		return this.route !== undefined;
	}

	/** The labels of the sends the loop holds: they count as wakes for the session's phase like a held send. */
	labels(): string[] {
		return [...this.held].flatMap((each) => each.labels);
	}

	/** Hands one send to the loop; false when it did not take it (an event it already holds). A throw leaves nothing held. */
	take(held: Held, events: readonly PayloadEvent[], sources: readonly Source[], steer: boolean): boolean {
		this.held.add(held);
		try {
			if (this.route?.({ events, sources, steer, held })) return true;
		} catch (error) {
			this.held.delete(held);
			throw error;
		}
		this.held.delete(held);
		return false;
	}

	/** Holds a send the loop already has (one replayed from its store). */
	adopt(held: Held): void {
		this.held.add(held);
	}

	/** The loop delivered these. */
	release(batch: readonly Held[]): void {
		for (const each of batch) this.held.delete(each);
	}
}
