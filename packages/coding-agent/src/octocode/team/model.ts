import type { Member, Traffic } from "@octocodeai/octocode-contacts/team";
import { num, type Row } from "../agentdb/rows.ts";
import { optionalString } from "../shared/util.ts";
import type { Ask } from "./asks.ts";

/** The team's records as the rest of the extension sees them, and how they are read from database rows. */

export interface Message {
	id: number;
	from: string;
	to: string;
	text: string;
	at: number;
	replyRequired: boolean;
	replyTo?: number;
	/** Whether it may start a turn of an idle recipient; decided when sent (`TeamStore.send`); absent means it waits. */
	wake?: boolean;
	/** Set when delivered: the sender's role and goal, unless it already left the team. */
	sender?: { role: string; goal?: string };
	/** Set when it stops a busy recipient's current step (its running tool is cancelled) and continues the run with it. */
	interrupt?: boolean;
	/** Set on a message the user typed for this recipient: the signature the parent made with the secret it gave the recipient (`userProof`). */
	proof?: string;
	/** Set when another agent forwarded this stored message to the recipient (`from` stays the original sender). */
	forwardedBy?: string;
	/** The forwarder's short note to this recipient. */
	note?: string;
}

/** How a message is sent: whether it asks for a reply, which message it answers, and whether it interrupts. */
export interface SendOptions {
	replyRequired?: boolean;
	replyTo?: number;
	interrupt?: boolean;
}

/**
 * What a team message carries in Octocode's `details`: the messages it puts in front of the model, oldest first. A team
 * notice (a lapsed reservation, a dead letter) is one entry without an id.
 */
export interface MailDetails {
	messages: Array<Pick<Message, "from" | "text" | "at"> & Partial<Message>>;
}

/** A message whose recipients left before reading it, or before answering its question, for its sender. */
export interface DeadLetter {
	id: number;
	recipients: string[];
	/** The recipients that read it but left without answering a `replyRequired` question (the others never read it). */
	read?: string[];
	text: string;
	/** Set when it was a relay through the sender's parent (`recipients` is that parent): the agent it was for, and why it failed. */
	relay?: { to: string; reason?: string };
}

export interface Lease {
	id: number;
	path: string;
	kind: "file" | "tree";
	owner: string;
	reason: string;
	acquiredAt: number;
	expiresAt: number;
}

export type LeaseRequest = Pick<Lease, "path" | "kind" | "reason">;

export function toMember(row: Row): Member {
	const goal = optionalString(row.task);
	const activity = optionalString(row.activity);
	const parentId = optionalString(row.parent_id);
	const model = optionalString(row.model);
	const started = optionalString(row.started);
	return {
		id: String(row.id),
		role: String(row.role),
		...(parentId ? { parentId } : {}),
		pid: num(row.pid),
		...(started ? { started } : {}),
		status: row.status === "working" ? "working" : "idle",
		...(goal ? { goal } : {}),
		...(activity ? { activity } : {}),
		...(model ? { model } : {}),
		joinedAt: num(row.joined_at),
		updatedAt: num(row.seen_at),
		toolCalls: num(row.tool_calls),
		input: num(row.input),
		cacheRead: num(row.cache_read),
		output: num(row.output),
		cost: num(row.cost),
		unpriced: num(row.unpriced) === 1,
		pending: num(row.pending),
	};
}

/** One `messages` row and its `deliveries` rows as the feed shows it: queued until every recipient saw it or left. */
export function toTraffic(row: Row, deliveries: Row[]): Traffic {
	const state: Traffic["state"] = deliveries.some((d) => d.delivered_at === null && d.dead_at === null)
		? "queued"
		: deliveries.length === 0 || deliveries.some((d) => d.dead_at !== null)
			? "dead-lettered"
			: row.reply_required === 1
				? deliveries.every((d) => d.completed_at !== null)
					? "answered"
					: "awaiting reply"
				: "delivered";
	const replyTo = row.reply_to;
	return {
		id: num(row.id),
		from: String(row.sender),
		to: deliveries.map((d) => String(d.recipient)),
		text: String(row.body),
		at: num(row.created_at),
		...(typeof replyTo === "number" ? { replyTo } : {}),
		state,
	};
}

/** One question to a parent: a `messages` row, with the first reply of the recipient (`reply_id`, `reply_at`, `reply_by`) when there is one. */
export function toAsk(row: Row): Ask {
	const answered = typeof row.reply_id === "number";
	return {
		id: num(row.id),
		text: String(row.body),
		askedAt: num(row.created_at),
		...(answered ? { answer: { id: num(row.reply_id), at: num(row.reply_at), by: String(row.reply_by) } } : {}),
	};
}

export function toLease(row: Row): Lease {
	return {
		id: num(row.id),
		path: String(row.path),
		kind: row.kind === "tree" ? "tree" : "file",
		owner: String(row.owner),
		reason: String(row.reason),
		acquiredAt: num(row.acquired_at),
		expiresAt: num(row.expires_at),
	};
}

/** `deliveries.wake`: whether a delivery may start an idle recipient's turn, and whether it interrupts the current one. */
export const WAKE = { none: 0, wake: 1, interrupt: 2 } as const;

/** A message waiting for `to`, from a row that also carries the sender's role and goal (`sender_role`, `sender_goal`) while it is still on the team. */
export function toMessage(row: Row, to: string): Message {
	const replyTo = row.reply_to;
	const wake = row.wake;
	const role = optionalString(row.sender_role);
	const goal = optionalString(row.sender_goal);
	const forwardedBy = optionalString(row.forwarded_by);
	const note = optionalString(row.note);
	return {
		id: num(row.id),
		from: String(row.sender),
		to,
		text: String(row.body),
		at: num(row.created_at),
		replyRequired: row.reply_required === 1,
		...(typeof replyTo === "number" ? { replyTo } : {}),
		wake: num(wake) >= WAKE.wake,
		...(wake === WAKE.interrupt ? { interrupt: true } : {}),
		...(typeof row.proof === "string" ? { proof: row.proof } : {}),
		...(role ? { sender: { role, ...(goal ? { goal } : {}) } } : {}),
		...(forwardedBy ? { forwardedBy } : {}),
		...(forwardedBy && note ? { note } : {}),
	};
}
