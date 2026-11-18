import { type Db, correspondence, deliveries, num } from "../../../../../db/src/api.ts";
import { USER_SENDER } from "../../shared/messages.ts";
import type { Ask } from "../asks.ts";
import { type DeadLetter, type Message, type SendOptions, toAsk, toMessage, toTraffic, WAKE } from "../model.ts";
import { INBOX_BATCH_SIZE } from "./limits.ts";
import type { Traffic } from "@octocodeai/octocode-contracts/team";

/** The message rows behind `TeamStore` (`store.ts`); each is described on the `TeamStore` method that runs it. */

/** Makes the `proof` of message `id` for `recipient` (see `userProof`); undefined for a recipient the caller cannot sign for. */
export type SignProof = (id: number, recipient: string) => string | undefined;

export function insertMessage(
	db: Db,
	team: string,
	workspaceId: string,
	/** The recipients that can still read mail (`TeamStore.reachable`), read in the same transaction. */
	live: Set<string>,
	from: string,
	to: string[],
	body: string,
	options: SendOptions & { replyRequired: boolean; wake?: boolean; sign?: SignProof },
	now: number,
): { id: number | undefined; departed: string[]; woken: string[] } {
	const departed = to.filter((recipient) => !live.has(recipient));
	const recipients = to.filter((recipient) => live.has(recipient));
	if (recipients.length === 0) return { id: undefined, departed, woken: [] };
	// The asker is woken by the answer to its own open question, never by a reply to an FYI or a thank-you.
	let asker: string | undefined;
	let completesReply = false;
	if (options.replyTo !== undefined) {
		const question = deliveries.replyTarget(db, team, options.replyTo);
		if (question?.replyRequired && deliveries.holdsOpen(db, options.replyTo, from)) asker = question.from;
		completesReply = question !== undefined && recipients.includes(question.from);
	}
	const id = deliveries.insertMessage(db, team, workspaceId, from, body, options.replyRequired, options.replyTo, now);
	const woken: string[] = [];
	for (const recipient of recipients) {
		const wake = options.interrupt
			? WAKE.interrupt
			: options.wake || options.replyRequired || recipient === asker
				? WAKE.wake
				: WAKE.none;
		if (wake !== WAKE.none) woken.push(recipient);
		deliveries.insertDelivery(db, { message: id, recipient, wake, proof: options.sign?.(id, recipient) });
	}
	if (options.replyTo !== undefined && completesReply) deliveries.complete(db, options.replyTo, from, now);
	return { id, departed, woken };
}

export function asks(db: Db, team: string, child: string, parent: string, since: number): Ask[] {
	return deliveries.asks(db, team, child, parent, USER_SENDER, since).map(toAsk);
}

export function deadLetters(db: Db, team: string, sender: string, limit = INBOX_BATCH_SIZE): DeadLetter[] {
	const letters = new Map<number, DeadLetter>();
	for (const row of deliveries.deadLetters(db, team, sender, limit)) {
		const id = num(row.id);
		const relay =
			typeof row.relay_to === "string"
				? { relay: { to: row.relay_to, ...(typeof row.note === "string" ? { reason: row.note } : {}) } }
				: {};
		const letter = letters.get(id) ?? { id, recipients: [], text: String(row.body), ...relay };
		letter.recipients.push(String(row.recipient));
		if (row.delivered_at !== null) letter.read = [...(letter.read ?? []), String(row.recipient)];
		letters.set(id, letter);
	}
	return [...letters.values()];
}

export function pending(db: Db, id: string, after = 0): Message[] {
	return deliveries.waiting(db, id, after, INBOX_BATCH_SIZE).map((row) => toMessage(row, id));
}

export function pendingUrgent(db: Db, id: string, after: number, idle: boolean): Message | undefined {
	const row = deliveries.urgent(db, id, after, idle ? WAKE.wake : WAKE.interrupt);
	return row ? toMessage(row, id) : undefined;
}

export function recent(db: Db, team: string, limit = 30, now = Date.now(), windowMs = 10 * 60_000): Traffic[] {
	return deliveries
		.recentTraffic(db, team, now - windowMs, limit)
		.map(({ message, deliveries: states }) => toTraffic(message, states));
}

/**
 * A page of the team's whole message history, newest first: `limit` messages older than `before` (the newest when absent).
 * Unlike `recent`, nothing but `limit` bounds it; the next page starts at the oldest one returned (`messageBound` of the feed cursor).
 */
export function history(db: Db, team: string, limit: number, before?: correspondence.MessageCursor): Traffic[] {
	return correspondence
		.page(db, team, limit, before)
		.map(({ message, deliveries: states }) => toTraffic(message, states));
}
