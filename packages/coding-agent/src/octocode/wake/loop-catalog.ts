import type { EventCatalog, Priority } from "../events/loop/types.ts";
import type { PayloadEvent } from "../events/topics.ts";
import { CATALOG, describeEvent } from "./catalog.ts";

/**
 * How soon an event is delivered. The one place that decides it, from the event's own data: a team message its sender
 * was allowed to mark `interrupt` (the agent that started the recipient, or the user: `team/routing.ts`) is urgent, and
 * everything else is the next task. No sender passes a priority, and no instruction asks the model to rank messages.
 */
function priorityOfEvent(event: PayloadEvent): Priority {
	return event.kind === "agent.message" && event.interrupt ? "urgent" : "regular";
}

/** The priority of one send: urgent when any of the events behind it is. */
export const priorityOfEvents = (events: readonly PayloadEvent[]): Priority =>
	events.some((event) => priorityOfEvent(event) === "urgent") ? "urgent" : "regular";

/** The wake catalog as the loop reads it: digests and keys from the entries, wakes where an entry always wakes. */
export const wakeCatalog: EventCatalog = {
	describe: describeEvent,
	wakes: (topic) => CATALOG[topic].wakes === "yes",
	priority: priorityOfEvent,
};
