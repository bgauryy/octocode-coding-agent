import { CATALOG, parseEventKind } from "../wake/catalog.ts";
import { type LiveJob, polledJob } from "./job-poll.ts";

/** What an `on` call names beside its event: the fields of `filter`, each event taking its own. */
export interface EventFilter {
	ref?: string;
	state?: string;
	path?: string;
	agent?: string;
	command?: string;
	epic?: string;
	change?: string;
	/** machine.load: wait until the load per core is below or above this, for this many samples in a row. */
	perCoreBelow?: number;
	perCoreAbove?: number;
	for?: number;
}

/** What `until` an event stands for, and the filter fields it takes: `required` all, and at least one of `oneOf` when given. */
interface Listener {
	required: readonly (keyof EventFilter)[];
	optional?: readonly (keyof EventFilter)[];
	oneOf?: readonly (keyof EventFilter)[];
	until(filter: EventFilter): object;
}

const defined = <T extends object>(value: T) =>
	Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined));

/**
 * The filter fields each listenable name takes, and the `until` condition each maps to. `item.state`, `item.changed`,
 * `peer.landed` and `path.unlocked` are names of the `on` call only: the session is told by a `check.result` when the
 * condition holds, and no event of those kinds exists.
 */
const LISTENERS = {
	"agent.ended": { required: ["agent"], until: (f) => ({ agent: { name: f.agent } }) },
	"item.state": { required: ["ref", "state"], until: (f) => ({ item: { ref: f.ref, state: f.state } }) },
	"item.changed": {
		required: [],
		optional: ["ref", "epic", "path", "change"],
		oneOf: ["ref", "epic", "path"],
		until: (f) => ({ changed: defined({ ref: f.ref, epic: f.epic, path: f.path, change: f.change }) }),
	},
	"peer.landed": {
		required: ["ref"],
		optional: ["path", "agent"],
		until: (f) => ({ landed: defined({ ref: f.ref, path: f.path, agent: f.agent }) }),
	},
	"path.unlocked": { required: ["path"], until: (f) => ({ unlocked: f.path }) },
	"machine.load": {
		required: [],
		optional: ["perCoreBelow", "perCoreAbove", "for"],
		oneOf: ["perCoreBelow", "perCoreAbove"],
		until: (f) => ({ machine: defined({ below: f.perCoreBelow, above: f.perCoreAbove, for: f.for }) }),
	},
	"check.result": { required: ["command"], until: (f) => ({ command: f.command }) },
} satisfies Record<string, Listener>;

/** The events `on` listens for. */
export const LISTEN_EVENTS = Object.keys(LISTENERS) as [keyof typeof LISTENERS, ...(keyof typeof LISTENERS)[]];

/**
 * The `until` condition an `on` call stands for. `event` is parsed against the closed catalog: an event that already wakes
 * the session (a child's report, a job's exit) is refused with that reason, `time.due` points at `set`. `check` is the
 * question a small model judges once the event holds. A `check.result` command that polls one of `session.jobs` is
 * refused: the session is already notified when that job ends.
 */
export function untilOfEvent(
	event: unknown,
	filter: EventFilter | undefined,
	check: string | undefined,
	session: { jobs: readonly LiveJob[]; cwd: string } = { jobs: [], cwd: process.cwd() },
): object {
	if (event === undefined) throw new Error(`on needs an event: ${LISTEN_EVENTS.join(", ")}.`);
	const kind = typeof event === "string" && Object.hasOwn(LISTENERS, event) ? event : parseEventKind(event);
	if (kind === "time.due") throw new Error("time.due is a time: use set with after or every.");
	if (kind in CATALOG && CATALOG[kind as keyof typeof CATALOG].listener === "implicit")
		throw new Error(`You are already notified when ${kind} happens; asking for it adds nothing.`);
	const listener = (LISTENERS as Record<string, Listener>)[kind];
	const takes = [...listener.required, ...(listener.optional ?? [])] as string[];
	const given = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);
	const unknown = given.filter(([key]) => !takes.includes(key));
	if (unknown.length)
		throw new Error(`${kind} filters on ${takes.join(", ")}, not ${unknown.map(([key]) => key).join(", ")}.`);
	const set = (field: keyof EventFilter) => {
		const value = filter?.[field];
		return typeof value === "number" || (typeof value === "string" && value.trim() !== "");
	};
	for (const field of listener.required) if (!set(field)) throw new Error(`${kind} needs filter.${field}.`);
	if (listener.oneOf && !listener.oneOf.some(set))
		throw new Error(`${kind} needs one of filter.${listener.oneOf.join(", filter.")}.`);
	if (check !== undefined && filter?.command !== undefined && sameCommand(check, filter.command))
		throw new Error(
			"check repeats filter.command: the command alone notifies you free when it exits 0. check is a question in words that a paid small model judges after that; drop it.",
		);
	const polled = filter?.command === undefined ? undefined : polledJob(filter.command, session.jobs, session.cwd);
	if (polled)
		throw new Error(
			`You are already notified when ${polled.id} ends, with its exit and log: filter.command polling it adds nothing. Nothing was set.`,
		);
	const until = listener.until(filter ?? {});
	return check === undefined ? until : { ...until, check };
}

/** The same shell text, ignoring quotes and spacing: `grep -q "x" f` and `grep -q x f`. */
const sameCommand = (a: string, b: string): boolean => {
	const bare = (text: string) => text.replace(/["']/g, "").replace(/\s+/g, " ").trim();
	return bare(a) === bare(b);
};
