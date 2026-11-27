import { makeSource } from "../events/source.ts";
import type { Source } from "../events/source-types.ts";
import { EXTERNAL_SENDER, USER_SENDER } from "../shared/messages.ts";
import type { Message } from "./model.ts";

/** What this process checked about a message: the owner's record of it, never its text. */
export interface MailProof {
	/** The user's own message, proven by the typing side's record or signature. */
	fromUser: boolean;
	/** The coordinator's signature on the message. */
	parentSigned: boolean;
}

/**
 * The source of one team message. Only the user's proven message reaches the terminal source; a peer that claims to be the
 * user, a client of the local API and an unsigned coordinator stay self-reported (trust 0). The sender of a forwarded
 * message is the forwarder, with the original sender as `via`.
 */
export function mailSource(message: Message, parentId: string | undefined, proof: MailProof): Source {
	const via = message.forwardedBy === undefined ? {} : { identity: { via: message.from } };
	const relayed = message.forwardedBy ?? message.from;
	if (message.from === USER_SENDER && message.forwardedBy === undefined)
		return proof.fromUser
			? makeSource("terminal", USER_SENDER, "terminal", "proven")
			: makeSource("peer", USER_SENDER, "db", "self-reported");
	if (message.from === EXTERNAL_SENDER)
		return makeSource(
			"external",
			EXTERNAL_SENDER,
			"db",
			"self-reported",
			message.forwardedBy ? { via: message.forwardedBy } : undefined,
		);
	const signed = message.from === parentId && proof.parentSigned && (message.forwardedBy ?? parentId) === parentId;
	return makeSource("peer", relayed, "db", signed ? "proven" : "self-reported", via.identity);
}

/** A team notice (a lapsed reservation, a dead letter): our own code wrote it. */
export const TEAM_NOTICE_SOURCE: Source = makeSource("system", "team", "in-process", "proven");
