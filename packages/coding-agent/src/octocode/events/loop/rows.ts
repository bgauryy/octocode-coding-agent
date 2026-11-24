import type { EventRow, NewEvent, NewSubscription, SubscriptionRow } from "../../../../../db/src/api.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { EventCatalog, EventEntry } from "./types.ts";
import type { Handle, Source } from "../source-types.ts";
import { type AgentEvent, isTopic, type Subscription, type TopicFilter, type TopicPayload } from "../topics.ts";

/**
 * The two mappings between the runtime's types (`events/topics.ts`) and the database rows (`packages/db` `events` and
 * `eventSubscriptions`). The database stores JSON text and never reads inside it; this file is the only place that
 * parses or writes that text, and it fails loudly on a row it cannot read.
 */

/** An event before the log gave it a `seq`. */
export type NewAgentEvent = Omit<AgentEvent, "seq">;

/** The durable event fields derived from a live input, before the log assigns its sequence. */
export function publication<C>(entry: Omit<EventEntry<C>, "type">, catalog: EventCatalog, at: number): NewAgentEvent {
	const { label, key } = catalog.describe(entry.event);
	const { kind, ...payload } = entry.event;
	return {
		topic: kind,
		key,
		at,
		source: entry.source,
		payload,
		digest: label,
		...(entry.dedupeKey === undefined ? {} : { dedupeKey: entry.dedupeKey }),
		...(entry.body === undefined ? {} : { body: entry.body }),
	};
}

/** The topic a subscription to every topic carries (the database reads a pattern only as `group.*`). */
export const ALL_TOPICS = "*";

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${what} is not JSON: ${(error as Error).message}`, { cause: error });
	}
}

function parseRecord(text: string, what: string): Record<string, unknown> {
	const value = parseJson(text, what);
	if (!isRecord(value)) throw new Error(`${what} is not an object`);
	return value;
}

/** Where an event's replay body sits inside the stored payload: no column of its own, and a payload field never starts with it. */
const BODY_KEY = "$body";

export function toNewEvent(workspaceId: string, sessionId: string | undefined, event: NewAgentEvent): NewEvent {
	return {
		workspaceId,
		...(sessionId === undefined ? {} : { sessionId }),
		at: event.at,
		topic: event.topic,
		key: event.key,
		source: JSON.stringify(event.source),
		payload: JSON.stringify(event.body === undefined ? event.payload : { ...event.payload, [BODY_KEY]: event.body }),
		digest: event.digest,
		...(event.ref === undefined ? {} : { ref: JSON.stringify(event.ref) }),
		...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
	};
}

export function fromEventRow(row: EventRow): AgentEvent {
	if (!isTopic(row.topic)) throw new Error(`event ${row.seq} has the unknown topic ${JSON.stringify(row.topic)}`);
	const { [BODY_KEY]: body, ...payload } = parseRecord(row.payload, `event ${row.seq} payload`);
	if (body !== undefined && !isRecord(body)) throw new Error(`event ${row.seq} body is not an object`);
	return {
		seq: row.seq,
		topic: row.topic,
		key: row.key,
		at: row.at,
		// The writer stored a `Source` and a topic payload; the log does not check them again.
		source: parseRecord(row.source, `event ${row.seq} source`) as unknown as Source,
		payload: payload as unknown as TopicPayload<typeof row.topic>,
		digest: row.digest,
		...(body === undefined ? {} : { body }),
		...(row.ref === null ? {} : { ref: parseRecord(row.ref, `event ${row.seq} ref`) as unknown as Handle }),
		...(row.dedupe_key === null ? {} : { dedupeKey: row.dedupe_key }),
	};
}

export interface SubscriptionOwner {
	workspaceId: string;
	sessionId?: string;
	pid?: number;
	started?: string;
}

/** `startAt`: where a new subscription starts reading (`events.lastSeq`). */
export function toNewSubscription(
	owner: SubscriptionOwner,
	sub: Subscription,
	startAt: number,
	at: number,
): NewSubscription {
	return {
		workspaceId: owner.workspaceId,
		...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
		subscriber: sub.subscriber,
		topic: sub.topic,
		...(sub.where === undefined ? {} : { filter: JSON.stringify(sub.where) }),
		deliver: sub.deliver,
		durable: sub.durable,
		action: JSON.stringify(sub.action),
		...(sub.once ? { once: true } : {}),
		...(sub.costGate ? { costMaxPerHour: sub.costGate.maxPerHour } : {}),
		startAt,
		...(owner.pid === undefined ? {} : { ownerPid: owner.pid }),
		...(owner.started === undefined ? {} : { ownerStarted: owner.started }),
		...(sub.expiresAt === undefined ? {} : { expiresAt: sub.expiresAt }),
		at,
	};
}

/** The subscription and where it has read to. */
export function fromSubscriptionRow(row: SubscriptionRow): { id: number; offset: number; subscription: Subscription } {
	const topic = row.topic;
	if (topic !== ALL_TOPICS && !isTopic(topic) && !/^[a-z]+\.\*$/.test(topic))
		throw new Error(`subscription ${row.id} has the unknown topic ${JSON.stringify(topic)}`);
	const action = parseRecord(row.action, `subscription ${row.id} action`);
	return {
		id: row.id,
		offset: row.offset_seq,
		subscription: {
			subscriber: row.subscriber,
			topic: topic as Subscription["topic"],
			...(row.filter === "" ? {} : { where: parseRecord(row.filter, `subscription ${row.id} filter`) as TopicFilter }),
			deliver: row.deliver,
			durable: row.durable === 1,
			action: action as unknown as Subscription["action"],
			...(row.once === 1 ? { once: true } : {}),
			...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
			...(row.cost_max_per_hour === null ? {} : { costGate: { maxPerHour: row.cost_max_per_hour } }),
		},
	};
}
