import {
	HOOK_LIFECYCLE_EVENTS,
	type HookLifecyclePayload,
	type HookLifecycleTopic,
	hookTopic,
} from "./hook-lifecycle.ts";
import type { Handle, Source } from "./source-types.ts";
/**
 * The closed list of event topics and their payload types, plus the envelope an event travels in. A leaf over
 * `source-types.ts`: serializable types only, so the wake gate, timers, mail and later the event log depend on it freely.
 * How each topic reads as a row (label, dedupe key, wake policy) stays in `wake/catalog.ts`.
 */

/** The payload of each topic. */
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
	"item.ready": { ref: string; prerequisites: string[] };
	/** A peer's change to an item related to one this session holds or waits on (`backlog/peer-notify.ts`); `id` is its audit row. */
	"item.peer": { ref: string; change: string; by: string; relation: string; id: number };
	/** A QA review the gate owes because no reviewer could start (`backlog/qa-owed.ts`): the item and the cause. */
	"qa.unavailable": { item: string; cause: string };
	/** The host's load per core met a `machine` wait (`wait on machine.load`); published once per wait, from the sampler's samples. */
	"machine.load": { timerId: number; perCore: number; samples: number };
	/**
	 * A monitor rule that tripped for this session (`monitor/attention/rules.ts`): a machine threshold its processes tripped,
	 * a stuck job, an idle child (`idle-agent`, whose `subject` is the child), held items nothing works on (`idle-items`, whose `subject` is the refs joined by `,`), or a delegated item with no progress (`stalled-item`, whose `subject` is the item).
	 */
	"monitor.alert": { rule: string; value: number; threshold: number; at: number; subject?: string };
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
	/** A callback ticket resolved once (`events/tickets.ts`): `on` is what resolved it, `note` the requester's own reminder. */
	"ticket.resolved": { ticket: number; on: string; requester: string; target: string; note?: string; result: string };
	/** A callback ticket that cannot resolve: `reason` is `timeout`, `loop`, `left` or `cancelled`; `ticket` is absent for a refused request. */
	"ticket.rejected": { ticket?: number; on: string; requester: string; target: string; note?: string; reason: string };
}

/** Every topic's payload: the list above and one `hook.<Event>` per hook lifecycle event (`hook-lifecycle.ts`). */
type AllPayloads = EventPayloads & { [K in HookLifecycleTopic]: HookLifecyclePayload };

export type Topic = keyof AllPayloads;

export type TopicPayload<K extends Topic> = AllPayloads[K];

/** One event as a source emits it, before it has a sequence number or a source: the kind and its payload fields. */
export type PayloadEvent<K extends Topic = Topic> = { [P in K]: { kind: P } & AllPayloads[P] }[K];

/** The topics as a runtime list; the `Record` makes the compiler fail when it and `EventPayloads` drift apart. */
const TOPIC_SET: Record<Topic, true> = {
	...(Object.fromEntries(HOOK_LIFECYCLE_EVENTS.map((event) => [hookTopic(event), true])) as Record<
		HookLifecycleTopic,
		true
	>),
	"agent.report": true,
	"agent.ended": true,
	"agent.message": true,
	"job.exit": true,
	"item.ready": true,
	"item.peer": true,
	"qa.unavailable": true,
	"machine.load": true,
	"monitor.alert": true,
	"check.result": true,
	"time.due": true,
	"hook.feedback": true,
	"wake.retry": true,
	"peer.notice": true,
	"ticket.resolved": true,
	"ticket.rejected": true,
};

export const TOPICS = Object.keys(TOPIC_SET) as Topic[];

export function isTopic(value: unknown): value is Topic {
	return typeof value === "string" && Object.hasOwn(TOPIC_SET, value);
}

/** The group of a topic: the text before its first dot (`job` for `job.exit`). */
export function topicGroup(topic: Topic): string {
	return topic.slice(0, topic.indexOf("."));
}

/** A field-equals filter over a payload: every entry must match. */
export type TopicFilter = Record<string, string | number | boolean | null>;

/** Run a hook handler (by its id) when a matching event arrives. */
interface HookAction {
	type: "hook";
	hook: string;
	/** The handler kinds the hook runs (`command`, `http`, `prompt`, `mcp_tool`, or `internal`), for a reader of the row. */
	kinds?: readonly string[];
}

/** Message an agent with a callback text when a matching event arrives. */
interface MessageAction {
	type: "message";
	to: string;
	text: string;
}

export interface Subscription {
	subscriber: string;
	topic: Topic | `${string}.*`;
	where?: TopicFilter;
	deliver: "wake" | "piggyback" | "record";
	durable: boolean;
	action: HookAction | MessageAction;
	once?: boolean;
	expiresAt?: number;
	costGate?: { maxPerHour: number };
}

/** An event in the log: a payload with its place in the order, its source and the one line the model may see. */
export interface AgentEvent<K extends Topic = Topic> {
	seq: number;
	topic: K;
	key: string;
	at: number;
	source: Source;
	/** Small and structured, never full output. */
	payload: TopicPayload<K>;
	/** One line, about 160 characters. */
	digest: string;
	/** Where the full object lives. */
	ref?: Handle;
	dedupeKey?: string;
	/** What a restarted session needs to deliver the event again (a topic whose delivery is durable): JSON, stored beside the payload. */
	body?: Record<string, unknown>;
}
