import { CATALOG, EXPLICIT_EVENTS, parseEventKind } from "../wake/catalog.ts";

/** What an `on` call names beside its event: the fields of `filter`, each event taking its own. */
export interface EventFilter {
	ref?: string;
	state?: string;
	path?: string;
	agent?: string;
	command?: string;
}

/** The filter fields each listenable event takes, and the `until` condition each maps to. */
const LISTENERS = {
	"agent.ended": { fields: ["agent"], until: (f: EventFilter) => ({ agent: { name: f.agent } }) },
	"item.state": { fields: ["ref", "state"], until: (f: EventFilter) => ({ item: { ref: f.ref, state: f.state } }) },
	"path.unlocked": { fields: ["path"], until: (f: EventFilter) => ({ unlocked: f.path }) },
	"check.result": { fields: ["command"], until: (f: EventFilter) => ({ command: f.command }) },
} as const;

/** The events `on` listens for. */
export const LISTEN_EVENTS = Object.keys(LISTENERS) as [keyof typeof LISTENERS, ...(keyof typeof LISTENERS)[]];

/**
 * The `until` condition an `on` call stands for. `event` is parsed against the closed catalog: an event that already wakes
 * the session (a child's report, a job's exit) is refused with that reason, `time.due` points at `set`. `check` is the
 * question a small model judges once the event holds.
 */
export function untilOfEvent(event: unknown, filter: EventFilter | undefined, check: string | undefined): object {
	if (event === undefined) throw new Error(`on needs an event: ${EXPLICIT_EVENTS.join(", ")}.`);
	const kind = parseEventKind(event);
	if (kind === "time.due") throw new Error("time.due is a time: use set with after or every.");
	if (CATALOG[kind].listener === "implicit")
		throw new Error(`${kind} already wakes you without a wait; listening for it adds nothing.`);
	const listener = LISTENERS[kind as keyof typeof LISTENERS];
	const given = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);
	const unknown = given.filter(([key]) => !(listener.fields as readonly string[]).includes(key));
	if (unknown.length)
		throw new Error(`${kind} filters on ${listener.fields.join(", ")}, not ${unknown.map(([key]) => key).join(", ")}.`);
	for (const field of listener.fields)
		if (typeof filter?.[field] !== "string" || !filter[field].trim()) throw new Error(`${kind} needs filter.${field}.`);
	const until = listener.until(filter ?? {});
	return check === undefined ? until : { ...until, check };
}
