import { type Db, correspondence, deliveries, num } from "../../../../../db/src/api.ts";
import { type Message, type OpenQuestion, type SendOptions, toMessage, toOpenQuestion, WAKE } from "../model.ts";
import { INBOX_BATCH_SIZE, MESSAGE_RETENTION_MS, STALE_MS } from "./limits.ts";
import { insertMessage } from "./mail.ts";

/**
 * Stored messages used by reference (`msg#N`): read one by id, forward it to more recipients without copying its body,
 * store a resumed run's message, and the B200 relay (a child's message to an agent it cannot reach, held as a delivery to
 * its parent with `relay_to`, which the parent process settles; `team/relay.ts`). Rows are those of `mail.ts`;
 * the columns are described in `packages/db/src/schema-sql.ts`. Authorization is the caller's (`team/session/references.ts`).
 */

/** A stored message and who holds a delivery of it. */
export interface StoredRow {
	id: number;
	from: string;
	text: string;
	at: number;
	replyRequired: boolean;
	replyTo?: number;
	deliveries: Array<{ recipient: string; forwardedBy?: string }>;
}

/** A relay request waiting for the parent process: the child's message, addressed (`to`) to the agent it is for. */
export interface RelayRequest {
	message: Message;
	target: string;
}

type Transaction = <T>(work: () => T) => T;

export class MessageRefs {
	private readonly db: Db;
	private readonly team: string;
	private readonly workspaceId: string;
	private readonly transaction: Transaction;
	private readonly reachable: () => Set<string>;
	constructor(db: Db, team: string, workspaceId: string, transaction: Transaction, reachable: () => Set<string>) {
		this.db = db;
		this.team = team;
		this.workspaceId = workspaceId;
		this.transaction = transaction;
		this.reachable = reachable;
	}

	/** Message `id` of this team with its deliveries; "expired" when retention removed it; undefined when it never existed here. */
	read(id: number): StoredRow | "expired" | undefined {
		const row = deliveries.messageRow(this.db, this.team, id);
		if (!row) {
			// Ids only grow (AUTOINCREMENT): a missing id below the highest one handed out was pruned, or lives in another repository.
			return Number.isInteger(id) && id > 0 && id <= deliveries.lastMessageId(this.db) ? "expired" : undefined;
		}
		const recipients = deliveries.recipientsOf(this.db, id).map((each) => ({
			recipient: String(each.recipient),
			...(typeof each.forwarded_by === "string" ? { forwardedBy: each.forwarded_by } : {}),
		}));
		const replyTo = row.reply_to;
		return {
			id: num(row.id),
			from: String(row.sender),
			text: String(row.body),
			at: num(row.created_at),
			replyRequired: row.reply_required === 1,
			...(typeof replyTo === "number" ? { replyTo } : {}),
			deliveries: recipients,
		};
	}

	/**
	 * Delivers stored message `id` to more recipients, in one write transaction: a delivery row each (the body is not
	 * copied) with `forwarded_by` and the note. Recipients that cannot read mail are `departed`; one that already holds a
	 * delivery of it is `already`. Nothing is added when the message is gone.
	 */
	forward(
		id: number,
		by: string,
		to: string[],
		options: { note?: string; wake: boolean; sign?: (recipient: string) => string | undefined },
	): { added: string[]; departed: string[]; already: string[] } {
		return this.transaction(() => {
			const live = this.reachable();
			const exists = deliveries.messageExists(this.db, this.team, id);
			const result = { added: [] as string[], departed: [] as string[], already: [] as string[] };
			for (const recipient of to) {
				if (!exists || !live.has(recipient)) result.departed.push(recipient);
				else if (deliveries.holds(this.db, id, recipient)) result.already.push(recipient);
				else {
					deliveries.insertDelivery(this.db, {
						message: id,
						recipient,
						wake: options.wake ? WAKE.wake : WAKE.none,
						forwardedBy: by,
						note: options.note,
						proof: options.sign?.(recipient),
					});
					result.added.push(recipient);
				}
			}
			return result;
		});
	}

	/**
	 * Stores the message that resumes the finished agent `to` (it is not a member, so `TeamStore.send` would refuse it), with
	 * its delivery already handed over: the resumed run starts with it and its inbox must not hand it over again. Its
	 * reply works like any other (`replyTo` this id). Returns the id and time; `retract` removes it when the resume fails.
	 */
	storeResumed(
		from: string,
		to: string,
		body: string,
		options: SendOptions & { replyRequired: boolean },
		now = Date.now(),
	): { id: number; at: number } {
		return this.transaction(() => {
			const { id } = insertMessage(this.db, this.team, this.workspaceId, new Set([to]), from, [to], body, options, now);
			deliveries.markDelivered(this.db, to, [id!], now);
			return { id: id!, at: now };
		});
	}

	/**
	 * Records stored message `id` as handed to `recipient` (not a member: a finished agent resumed with it), forwarded by
	 * `by` with its note, so the resumed run's inbox does not hand it over again; `dropDelivery` undoes it.
	 */
	handOver(id: number, recipient: string, by: string, note?: string, now = Date.now()): void {
		this.transaction(() => {
			deliveries.insertDelivery(this.db, { message: id, recipient, wake: WAKE.none, forwardedBy: by, note }, true);
			deliveries.markDelivered(this.db, recipient, [id], now);
		});
	}

	/** Removes `recipient`'s delivery of message `id` (a hand-over whose resume did not happen). */
	dropDelivery(id: number, recipient: string): void {
		this.transaction(() => deliveries.deleteDelivery(this.db, id, recipient));
	}

	/** Removes a message stored for a resume or relay that did not happen (with its deliveries). */
	retract(id: number): void {
		this.transaction(() => deliveries.deleteMessage(this.db, this.team, id));
	}

	/**
	 * A child's message to `target`, an agent it cannot reach, stored once as a relay request to its `parent`: the
	 * parent process resumes `target` with it, or dead-letters it with the reason. Undefined id when the parent left.
	 * A reply to a question `target` asked completes the child's delivery of that question now.
	 */
	relay(
		from: string,
		parent: string,
		target: string,
		body: string,
		options: SendOptions & { replyRequired: boolean },
		now = Date.now(),
	): number | undefined {
		return this.transaction(() => {
			const { replyTo, ...rest } = options;
			const { id } = insertMessage(
				this.db,
				this.team,
				this.workspaceId,
				this.reachable(),
				from,
				[parent],
				body,
				rest,
				now,
			);
			if (id === undefined) return undefined;
			deliveries.markRelay(this.db, id, parent, target, WAKE.none);
			if (replyTo !== undefined) {
				deliveries.setReplyTo(this.db, id, replyTo);
				if (deliveries.replyTarget(this.db, this.team, replyTo)?.from === target)
					deliveries.complete(this.db, replyTo, from, now);
			}
			return id;
		});
	}

	/** The mail part of the prune: mail nobody can read any more becomes a dead letter its sender is told of, then messages past retention with nothing open go. */
	prune(now: number): void {
		deliveries.deadLetterOrphans(this.db, now - STALE_MS, now);
		deliveries.pruneMessages(this.db, now - MESSAGE_RETENTION_MS);
	}

	/** The relay requests waiting for `parent`, oldest first (a bounded batch). */
	relays(parent: string): RelayRequest[] {
		return deliveries
			.relayRequests(this.db, this.team, parent, INBOX_BATCH_SIZE)
			.map((row) => ({ message: toMessage(row, String(row.relay_to)), target: String(row.relay_to) }));
	}

	/**
	 * Takes relay request `id` for `parent` and runs `settle` (`deliverRelay` or `failRelay`) in the same transaction: when
	 * `settle` throws, the take rolls back and the request waits for the next tick instead of staying taken and unsettled.
	 * False when it was already taken (or is gone).
	 */
	takeRelay(id: number, parent: string, settle: () => void, now = Date.now()): boolean {
		return this.transaction(() => {
			if (!deliveries.claimRelay(this.db, id, parent, now)) return false;
			settle();
			return true;
		});
	}

	/**
	 * Gives relayed message `id` to `target` and settles the request. `handed`: the target was resumed with it, so its
	 * delivery is already handed over (as `storeResumed`); otherwise (a live target) it waits in the target's inbox.
	 */
	deliverRelay(id: number, parent: string, target: string, handed: boolean, now = Date.now()): void {
		this.transaction(() => {
			const replyRequired = deliveries.replyTarget(this.db, this.team, id)?.replyRequired ?? false;
			deliveries.insertDelivery(
				this.db,
				{ message: id, recipient: target, wake: replyRequired ? WAKE.wake : WAKE.none },
				true,
			);
			if (handed) deliveries.markDelivered(this.db, target, [id], now);
			deliveries.settle(this.db, id, parent, now);
		});
	}

	/**
	 * The relay failed: its request becomes a settled dead letter with `reason` (the child is told once, `deadLetters`), and
	 * a delivery to `target` added for the attempt is removed.
	 */
	failRelay(id: number, parent: string, target: string, reason: string, now = Date.now()): void {
		this.transaction(() => {
			deliveries.deleteDelivery(this.db, id, target);
			deliveries.failDelivery(this.db, id, parent, reason, now);
		});
	}

	/**
	 * How many `replyRequired` questions `sender` sent to agents other than `parent` are still unanswered: no reply from that
	 * recipient yet, and the recipient has not left (a pending relay counts for the agent it is for).
	 */
	unansweredPeerAsks(sender: string, parent?: string): number {
		return deliveries.unansweredAsks(this.db, this.team, sender, parent ?? "");
	}

	/** The questions members of this team read and have not answered, oldest first (what `Member.pending` counts). */
	openQuestions(): OpenQuestion[] {
		return deliveries.openQuestions(this.db, this.team).map(toOpenQuestion);
	}

	/** Closes the questions `asker` put to `recipient` and settles their unreported dead letters: its report answered them. */
	closeQuestionsTo(asker: string, recipient: string, now = Date.now()): void {
		deliveries.closeQuestionsTo(this.db, asker, recipient, now);
	}

	/** When `a` and `b` last exchanged a message, in either direction; 0 when no such message is kept. */
	lastExchange(a: string, b: string): number {
		return deliveries.lastExchange(this.db, this.team, a, b);
	}

	/** Whether `other` is a correspondent of `me` (mail either way) and whether a question of `me` to it is unanswered. */
	correspondence(me: string, other: string, since = 0): correspondence.Correspondence {
		return correspondence.between(this.db, this.team, me, other, since);
	}

	/** Closes `recipient`'s open question `id` without an answer: its asker can no longer be reached. */
	closeQuestion(id: number, recipient: string, now = Date.now()): void {
		deliveries.complete(this.db, id, recipient, now);
	}
}
