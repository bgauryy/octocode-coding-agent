import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { num, type Row } from "../../../../db/src/api.ts";
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

/** How a message is sent: whether it asks for a reply, which message it answers, whether it interrupts, and whether it starts an idle recipient's turn without asking for a reply. */
export interface SendOptions {
	replyRequired?: boolean;
	replyTo?: number;
	interrupt?: boolean;
	/** Starts an idle recipient's turn (paced on the recipient's side, `wake-pace.ts`) with no reply expected. */
	wake?: boolean;
}

/**
 * How a sent message meets one recipient: woken to act now, read at its next step, quietly on its next turn, or held for a
 * recipient whose process runs but has not been seen for over a minute (`stalled`).
 */
export type DeliveryStatus = "wake" | "next-step" | "queued-quiet" | "stalled" | "pull";

/**
 * What a team message carries in Octocode's `details`: the messages it puts in front of the model, oldest first. A team
 * notice (a lapsed reservation, a dead letter) is one entry without an id.
 */
export interface MailDetails {
	messages: Array<Pick<Message, "from" | "text" | "at"> & Partial<Message>>;
}

/** A running child's model requests against its limits, as its parent's `coordinate` shows and grants them. */
export interface BudgetStanding {
	used: number;
	soft: number;
	/** Where the run stops. */
	hard: number;
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
	/** The recipients that were the sender's children, so its notice names their next step (`Mail.reportDeadLetters`). */
	kinds?: Record<string, RecipientKind>;
}

/** Whether a recipient was the sender's child, and whether that child filed its report. */
export interface RecipientKind {
	child: boolean;
	reported: boolean;
}

/** A `replyRequired` message `recipient` read and has not answered: what `Member.pending` counts. */
export interface OpenQuestion {
	recipient: string;
	id: number;
	from: string;
	text: string;
	at: number;
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

/** A requested path (as asked for) and the lease that blocks it. */
export interface LeaseConflict {
	path: string;
	heldBy: Lease;
}

export function toMember(row: Row): Member {
	const goal = optionalString(row.task);
	const activity = optionalString(row.activity);
	const parentId = optionalString(row.parent_id);
	const model = optionalString(row.model);
	const started = optionalString(row.started);
	const checkout = optionalString(row.checkout);
	const tmuxPane = optionalString(row.tmux_pane);
	const cwd = optionalString(row.cwd);
	const branch = optionalString(row.branch);
	const processTitle = optionalString(row.process_title);
	const sessionId = optionalString(row.session_id);
	return {
		id: String(row.id),
		role: String(row.role),
		...(row.mailbox === "pull" ? { mailbox: "pull" as const } : {}),
		...(parentId ? { parentId } : {}),
		pid: num(row.pid),
		...(started ? { started } : {}),
		status: row.status === "working" ? "working" : "idle",
		...(goal ? { goal } : {}),
		...(activity ? { activity } : {}),
		...(model ? { model } : {}),
		...(checkout ? { checkout } : {}),
		...(tmuxPane ? { tmuxPane } : {}),
		...(cwd ? { cwd } : {}),
		...(branch ? { branch } : {}),
		...(processTitle ? { processTitle } : {}),
		...(sessionId ? { sessionId } : {}),
		joinedAt: num(row.joined_at),
		updatedAt: num(row.seen_at),
		toolCalls: num(row.tool_calls),
		input: num(row.input),
		cacheRead: num(row.cache_read),
		cacheWrite: num(row.cache_write),
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
	const deliveredAt = Math.min(
		...deliveries.map((d) => (typeof d.delivered_at === "number" ? d.delivered_at : Infinity)),
	);
	// A failed relay request is the parent's errand, not a message it read or dropped (its `note` says why it failed).
	const dropped = deliveries
		.filter((d) => d.dead_at !== null && (d.relay_to === null || d.relay_to === undefined))
		.map((d) => ({ recipient: String(d.recipient), read: d.delivered_at !== null }));
	return {
		id: num(row.id),
		from: String(row.sender),
		to: deliveries.map((d) => String(d.recipient)),
		text: String(row.body),
		at: num(row.created_at),
		...(typeof replyTo === "number" ? { replyTo } : {}),
		...(Number.isFinite(deliveredAt) ? { deliveredAt } : {}),
		state,
		...(dropped.length > 0 ? { dropped } : {}),
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

export const toOpenQuestion = (row: Row): OpenQuestion => ({
	recipient: String(row.recipient),
	id: num(row.id),
	from: String(row.sender),
	text: String(row.body),
	at: num(row.created_at),
});

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
