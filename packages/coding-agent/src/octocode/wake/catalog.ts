import { clipText } from "@octocodeai/octocode-common/clip";
import {
	HOOK_LIFECYCLE_EVENTS,
	type HookLifecycleTopic,
	hookTopic,
	isLifecycleTopic,
} from "../events/hook-lifecycle.ts";
import type { PayloadEvent, Topic, TopicPayload } from "../events/topics.ts";
/**
 * How each event that can wake a session reads: one entry per topic (`events/topics.ts` owns the topic list and payload
 * types) with how the session hears of it, its dedupe key and its row label. A wake source names its kind here; the
 * `wait` tool parses `event` against this list. Adding an event is one payload type in `events/topics.ts` and one
 * `CATALOG` entry.
 */

export type AgentEventKind = Topic;

/** One event as a source emits it. */
export type AgentEvent<K extends AgentEventKind = AgentEventKind> = PayloadEvent<K>;

/**
 * `implicit`: the session hears of it without asking (its own children, jobs, mail, planned items); `explicit`: only
 * through a wait the agent set with `on`, `set` or `every`.
 */
type Listener = "implicit" | "explicit";

interface Entry<K extends AgentEventKind> {
	listener: Listener;
	/** Whether it starts a turn: always, never, or by a flag the source decides (a message, a job's stop reason). */
	wakes: "yes" | "sometimes";
	/** What the row says of it, in a few words. */
	label(payload: TopicPayload<K>): string;
	/** Equal keys are the same event: delivered once. */
	key(payload: TopicPayload<K>): string;
}

/** The refs of an `idle-items` alert, from its `subject`. */
const idleRefs = (subject: string | undefined): string[] => (subject ? subject.split(",") : []);

/** A hook run is logged, never delivered to the model: it is implicit and wakes nobody on its own. */
const LIFECYCLE_ENTRIES = Object.fromEntries(
	HOOK_LIFECYCLE_EVENTS.map((event) => [
		hookTopic(event),
		{
			listener: "implicit",
			wakes: "sometimes",
			label: () => `hook ${event}`,
			key: (p: { token: number }) => `hook:${event}:${p.token}`,
		},
	]),
) as unknown as { [K in HookLifecycleTopic]: Entry<K> };

export const CATALOG: { [K in AgentEventKind]: Entry<K> } = {
	...LIFECYCLE_ENTRIES,
	"agent.report": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `report ${p.agent} ${p.outcome}${p.item ? ` (${p.item})` : ""}`,
		key: (p) => `report:${p.reportId}`,
	},
	"agent.ended": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.agent} ended: ${p.reason}`,
		key: (p) => `ended:${p.agent}`,
	},
	"agent.message": {
		listener: "implicit",
		wakes: "sometimes",
		label: (p) => `message #${p.id} from ${p.from}`,
		key: (p) => `mail:${p.id}`,
	},
	"job.exit": {
		listener: "implicit",
		wakes: "sometimes",
		label: (p) => `job ${p.job} exit ${p.exit ?? "?"} · ${Math.round(p.durationMs / 1000)}s`,
		key: (p) => `job:${p.job}:${p.startedAt}`,
	},
	"item.state": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.ref} is ${p.state}`,
		key: (p) => `item:${p.ref}:${p.state}`,
	},
	"item.ready": {
		listener: "implicit",
		wakes: "yes",
		label: (p) =>
			p.prerequisites.length > 0 ? `${p.ref} ready: ${p.prerequisites.join(", ")} done` : `${p.ref} ready`,
		key: (p) => `ready:${p.ref}`,
	},
	"item.changed": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.ref} ${p.change} by ${clipText(p.by, 24)}`,
		key: (p) => `changed:${p.ref}:${p.change}:${p.by}`,
	},
	"peer.landed": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.ref} landed: ${p.how}`,
		key: (p) => `landed:${p.ref}:${p.how}`,
	},
	"item.peer": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `${p.ref} ${p.change} by ${clipText(p.by, 24)} (${p.relation})`,
		key: (p) => `peer:${p.ref}:${p.id}`,
	},
	"path.unlocked": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.path} unlocked`,
		key: (p) => `unlocked:${p.path}`,
	},
	"machine.load": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `load ${p.perCore} per core`,
		key: (p) => `machine:${p.timerId}`,
	},
	"monitor.alert": {
		listener: "implicit",
		wakes: "yes",
		label: (p) =>
			p.rule === "idle-items"
				? `${idleRefs(p.subject).join(", ")} idle: you hold it, nothing works on it`
				: p.rule === "idle-agent" || p.rule === "stalled-item"
					? `${clipText(p.subject ?? "agent", 24)} no progress for ${p.value} min`
					: `monitor: ${p.subject ? `${clipText(p.subject, 24)} ` : ""}${p.rule} ${p.value} (threshold ${p.threshold})`,
		key: (p) =>
			p.rule === "idle-items"
				? `idle:${idleRefs(p.subject).sort().join(",")}`
				: `monitor:${p.rule}:${p.subject ?? ""}:${p.at}`,
	},
	"check.result": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `check ${p.timerId} met`,
		key: (p) => `check:${p.timerId}`,
	},
	"time.due": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `notify ${p.timerId} · ${clipText(p.note, 60)}`,
		key: (p) => `time:${p.timerId}:${p.run}`,
	},
	"hook.feedback": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `hook ${p.event} feedback`,
		key: (p) => `hook:${p.hook}:${p.seq}`,
	},
	"wake.retry": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `retry after provider error (${p.attempt}/5)`,
		key: (p) => `retry:${p.attempt}`,
	},
	"peer.notice": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `peer: ${clipText(p.text, 60)}`,
		key: (p) => `peer:${p.seq}`,
	},
	"ticket.resolved": {
		listener: "implicit",
		wakes: "sometimes",
		label: (p) => `ticket ${p.ticket} resolved by ${clipText(p.target, 24)} (${p.on})`,
		key: (p) => `ticket:${p.ticket}`,
	},
	"ticket.rejected": {
		listener: "implicit",
		wakes: "sometimes",
		label: (p) => `ticket ${p.ticket ?? "request"} to ${clipText(p.target, 24)} rejected: ${p.reason}`,
		key: (p) => `ticket-rejected:${p.ticket ?? `${p.requester}:${p.target}`}:${p.reason}`,
	},
};

export const EVENT_KINDS = Object.keys(CATALOG) as AgentEventKind[];

/** The kinds a user or an agent can name: a hook run is the loop's own record. */
const NAMED_KINDS = EVENT_KINDS.filter((kind) => !isLifecycleTopic(kind));

/** The kinds a `wait` can listen for: the ones that need the agent to ask. */
export const EXPLICIT_EVENTS: AgentEventKind[] = EVENT_KINDS.filter((kind) => CATALOG[kind].listener === "explicit");

/** The kind `value` names, or an error naming the choices. */
export function parseEventKind(value: unknown): AgentEventKind {
	if (typeof value === "string" && Object.hasOwn(CATALOG, value) && !isLifecycleTopic(value))
		return value as AgentEventKind;
	throw new Error(`No event ${JSON.stringify(value)}: the choices are ${NAMED_KINDS.join(", ")}.`);
}

/** The one-line row text and dedupe key of an event. */
export function describeEvent<K extends AgentEventKind>(event: AgentEvent<K>): { label: string; key: string } {
	const entry = CATALOG[event.kind] as Entry<K>;
	return { label: entry.label(event), key: entry.key(event) };
}
