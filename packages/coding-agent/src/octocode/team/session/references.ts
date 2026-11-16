import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { say } from "../../shared/commands.ts";
import type { Message } from "../model.ts";
import { outside, resolveTarget } from "../routing.ts";
import type { StoredRow } from "../store/refs.ts";
import { MESSAGE_RETENTION_MS } from "../store/limits.ts";
import { finishedText, outbound, resumeWith, type SendHost } from "./send.ts";

/** A stored team message as a reference (`msg#N`) shows it: the original sender, id and time, and who holds a delivery. */
export interface StoredMessage {
	id: number;
	from: string;
	text: string;
	at: number;
	replyRequired: boolean;
	replyTo?: number;
	/** Who forwarded it to the requester, when the requester holds a forwarded delivery. */
	forwardedBy?: string;
	recipients: string[];
}

/** What references read of the team besides sending: whether this session started agent `id` (live or finished). */
export interface ReferenceHost extends SendHost {
	started(id: string): boolean;
}

/** A forward note stays short: longer text is a message of its own. */
const FORWARD_NOTE_MAX_CHARS = 1_000;

const HOURS = Math.round(MESSAGE_RETENTION_MS / 3_600_000);
/** One text for an id that never existed, expired, or that the requester may not read: none tells it the id exists. */
const notFound = (id: number) =>
	`no message #${id} that you can read in this repository (messages are kept ${HOURS} h)`;

/**
 * Message `id` for `requester`: its sender, any recipient (forwarded ones too), or the session that started the sender
 * or a recipient. Anyone else gets the same "no message" text as for an id that does not exist, so nothing leaks.
 */
export function readMessage(host: ReferenceHost, id: number, requester: string): StoredMessage | { error: string } {
	const db = host.store();
	const row = db.refs.read(id);
	if (!row || row === "expired" || !mayRead(host, row, requester)) return { error: notFound(id) };
	const forwardedBy = row.deliveries.find((each) => each.recipient === requester)?.forwardedBy;
	return {
		id: row.id,
		from: row.from,
		text: row.text,
		at: row.at,
		replyRequired: row.replyRequired,
		...(row.replyTo !== undefined ? { replyTo: row.replyTo } : {}),
		...(forwardedBy ? { forwardedBy } : {}),
		recipients: row.deliveries.map((each) => each.recipient),
	};
}

function mayRead(host: ReferenceHost, row: StoredRow, requester: string): boolean {
	const involved = [row.from, ...row.deliveries.map((each) => each.recipient)];
	if (involved.includes(requester)) return true;
	// The session that started an involved agent: this one for its own children, any other by the members' parent ids.
	if (requester === host.me()?.id && involved.some((agent) => host.started(agent))) return true;
	return host
		.store()
		.list()
		.some((member) => member.parentId === requester && involved.includes(member.id));
}

/**
 * Forwards stored message `id` from `by` to `to` (an id, role, "parent" or "all"): the recipients get the original
 * body, sender and id, with `by` named as forwarder and its short note; nothing is copied. A reply goes to the original
 * sender. A finished subagent of this session that lingers is resumed with it. `by` must be able to read the message.
 */
export async function forwardMessage(
	host: ReferenceHost,
	id: number,
	by: string,
	to: string,
	note?: string,
	signal?: AbortSignal,
): Promise<{ sent: string[]; id: number; departed?: string[]; resumed?: string } | { error: string }> {
	signal?.throwIfAborted();
	const trimmed = note?.trim() ? visibleControls(note.trim()) : undefined;
	if (trimmed && trimmed.length > FORWARD_NOTE_MAX_CHARS)
		return {
			error: `A forward note is at most ${FORWARD_NOTE_MAX_CHARS} characters; send longer text as its own message. Nothing was forwarded.`,
		};
	const stored = readMessage(host, id, by);
	if ("error" in stored) return { error: `Cannot forward: ${stored.error}. Nothing was forwarded.` };
	const { db, signal: joined, check, ready } = outbound(host, by, signal);
	const scope = outside(by) ? host.me()?.id : by;
	if (to === "all" && !scope) return { error: "No agents in this session yet: nothing to forward to." };
	const message = (recipient: string): Message => ({
		id,
		from: stored.from,
		to: recipient,
		text: stored.text,
		at: stored.at,
		replyRequired: stored.replyRequired,
		...(stored.replyTo !== undefined ? { replyTo: stored.replyTo } : {}),
		forwardedBy: by,
		...(trimmed ? { note: trimmed } : {}),
	});
	const targets = resolveTarget(db.list(), by, to, host.parentId(), scope, db.list(Date.now(), true));
	// The hook sees what each recipient reads, the forwarder's own note included, with the flags the delivery carries.
	const wake = stored.replyRequired || outside(by);
	const hookText = trimmed ? `${trimmed}\n\n${stored.text}` : stored.text;
	const hookFlags = { replyRequired: stored.replyRequired, wake, interrupt: false };
	const gate = (recipient: string) => check(recipient, hookText, stored.replyTo, hookFlags);
	if (typeof targets === "string") {
		if (!host.finished.has(to) || !host.resumer()) return { error: `${targets} Nothing was forwarded.` };
		if (stored.recipients.includes(to))
			return { error: `${to} already received message #${id}; send it a message instead. Nothing was forwarded.` };
		const denied = (await gate(to)) ?? ready();
		if (denied) return { error: denied };
		// The finished agent is resumed with the message; its delivery is recorded as handed over, and removed if the resume fails.
		const resumed = await resumeWith(
			host,
			to,
			by,
			() => {
				db.refs.handOver(id, to, by, trimmed);
				return { id, message: message(to), undo: () => db.refs.dropDelivery(id, to) };
			},
			stored.text,
			joined,
		);
		return resumed ? { sent: [to], id, resumed: resumed.resumed } : { error: finishedText(host, to) };
	}
	const recipients = targets.map((target) => target.id).filter((recipient) => recipient !== stored.from);
	if (recipients.length === 0)
		return {
			error: `${stored.from} sent message #${id}; there is no one else to forward it to. Nothing was forwarded.`,
		};
	for (const recipient of recipients) {
		const denied = await gate(recipient);
		if (denied) return { error: denied };
	}
	const notReady = ready();
	if (notReady) return { error: notReady };
	// It wakes the recipient when it asks for an answer (owed to the original sender) or comes from outside the team.
	const { added, departed, already } = db.refs.forward(id, by, recipients, {
		wake,
		...(trimmed ? { note: trimmed } : {}),
		// A parent's note is read as steering, so its forward carries the signature its own messages do.
		...(by === host.me()?.id ? { sign: (recipient: string) => host.signedByParent(message(recipient)) } : {}),
	});
	if (added.length === 0)
		return {
			error: [
				already.length > 0 ? `${already.join(", ")} already received message #${id}.` : "",
				departed.length > 0 ? `${departed.join(", ")} left the team.` : "",
				"Nothing was forwarded.",
			]
				.filter(Boolean)
				.join(" "),
		};
	return { sent: added, id, ...(departed.length > 0 ? { departed } : {}) };
}

/** Closes the questions this session put to `child`; housekeeping, so an unreadable database leaves them as they were. */
export function closeQuestionsTo(host: ReferenceHost, child: string): void {
	const me = host.me()?.id;
	if (!me) return;
	try {
		host.store().refs.closeQuestionsTo(me, child);
	} catch {
		/* The report is delivered either way. */
	}
}

/**
 * How many `replyRequired` questions agent `agentId` sent to agents other than this session (its parent) that are still
 * unanswered; 0 when the database cannot be read (a measurement never fails the run it describes), said once.
 */
export function unansweredPeerAsks(host: ReferenceHost, agentId: string): number {
	try {
		return host.store().refs.unansweredPeerAsks(agentId, host.me()?.id);
	} catch (error) {
		const ctx = host.ctx();
		if (!peerAsksWarned && ctx) {
			peerAsksWarned = true;
			say(
				ctx,
				`Could not count ${agentId}'s open questions to other agents (${errorMessage(error)}); it stays resumable only for its default window.`,
				"warning",
			);
		}
		return 0;
	}
}
let peerAsksWarned = false;
