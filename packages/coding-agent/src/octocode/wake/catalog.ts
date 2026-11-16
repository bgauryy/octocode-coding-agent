/**
 * The closed list of events that can wake a session: one entry per kind with its payload type, how the session hears of it,
 * its dedupe key and its row label. A wake source names its kind here; the `wait` tool parses `event` against this list.
 * Adding an event is one payload type and one `CATALOG` entry.
 */

/** The payload of each kind. */
interface EventPayloads {
	"agent.report": {
		agent: string;
		role: string;
		outcome: string;
		item?: string;
		reportId: string;
		reportPath?: string;
	};
	"agent.ended": { agent: string; reason: string; detail?: string };
	"agent.message": { from: string; id: number; replyRequired: boolean; interrupt: boolean };
	"job.exit": {
		job: string;
		exit: number | null;
		durationMs: number;
		startedAt: number;
		log?: string;
		stopped?: boolean;
	};
	"item.state": { ref: string; state: string };
	"item.ready": { ref: string; prerequisites: string[] };
	"item.idle": { refs: string[] };
	"path.unlocked": { path: string };
	"check.result": {
		timerId: number;
		command?: string;
		question?: string;
		exit: number | null;
		output: string;
		costUsd?: number;
	};
	"time.due": { timerId: number; run: number; maxRuns?: number; note: string };
	"hook.feedback": { hook: string; event: string; text: string; seq: number };
	"wake.retry": { attempt: number; error: string };
	"peer.notice": { text: string; seq: number };
}

export type AgentEventKind = keyof EventPayloads;

/** One event as a source emits it. */
export type AgentEvent<K extends AgentEventKind = AgentEventKind> = { [P in K]: { kind: P } & EventPayloads[P] }[K];

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
	label(payload: EventPayloads[K]): string;
	/** Equal keys are the same event: delivered once. */
	key(payload: EventPayloads[K]): string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const CATALOG: { [K in AgentEventKind]: Entry<K> } = {
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
	"item.idle": {
		listener: "implicit",
		wakes: "yes",
		label: (p) => `${p.refs.join(", ")} idle: you hold it, nothing works on it`,
		key: (p) => `idle:${[...p.refs].sort().join(",")}`,
	},
	"path.unlocked": {
		listener: "explicit",
		wakes: "yes",
		label: (p) => `${p.path} unlocked`,
		key: (p) => `unlocked:${p.path}`,
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
		label: (p) => `wait ${p.timerId} · ${clip(p.note, 60)}`,
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
		label: (p) => `peer: ${clip(p.text, 60)}`,
		key: (p) => `peer:${p.seq}`,
	},
};

export const EVENT_KINDS = Object.keys(CATALOG) as AgentEventKind[];

/** The kinds a `wait` can listen for: the ones that need the agent to ask. */
export const EXPLICIT_EVENTS = EVENT_KINDS.filter((kind) => CATALOG[kind].listener === "explicit");

/** The kind `value` names, or an error naming the choices. */
export function parseEventKind(value: unknown): AgentEventKind {
	if (typeof value === "string" && Object.hasOwn(CATALOG, value)) return value as AgentEventKind;
	throw new Error(`No event ${JSON.stringify(value)}: the choices are ${EVENT_KINDS.join(", ")}.`);
}

/** The one-line row text and dedupe key of an event. */
export function describeEvent<K extends AgentEventKind>(event: AgentEvent<K>): { label: string; key: string } {
	const entry = CATALOG[event.kind] as Entry<K>;
	return { label: entry.label(event), key: entry.key(event) };
}
