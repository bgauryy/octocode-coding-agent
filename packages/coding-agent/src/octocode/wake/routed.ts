import type { Source } from "../events/source-types.ts";
import type { Priority } from "../events/loop/types.ts";
import type { PayloadEvent } from "../events/topics.ts";
import type { GateRoute, Held } from "./gate-types.ts";

/** Only the first wake is displayed in the session phase. */
export function firstWakeLabel(sends: Iterable<Pick<Held, "labels">>): string | undefined {
	for (const send of sends) if (send.labels.length) return send.labels[0];
	return undefined;
}

/** The messages awaiting dispatch from this session loop. */
export class Routed {
	private route: GateRoute | undefined;
	private readonly held = new Set<Held>();

	/** Attaches the live loop's intake; `undefined` detaches the session route. */
	set(route: GateRoute | undefined): void {
		this.route = route;
		if (!route) this.held.clear();
	}

	get active(): boolean {
		return this.route !== undefined;
	}

	/** The phase displays the first pending wake. */
	firstLabel(): string | undefined {
		return firstWakeLabel(this.held);
	}

	/** Hands one send to the loop; false when it did not take it (an event it already holds). A throw leaves nothing held. */
	async take(
		held: Held,
		events: readonly PayloadEvent[],
		sources: readonly Source[],
		priority: Priority,
	): Promise<boolean> {
		this.held.add(held);
		try {
			const taken = this.route?.({ events, sources, priority, held });
			if (taken instanceof Promise ? await taken : taken) return true;
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
	release(held: Held): void {
		this.held.delete(held);
	}
}
