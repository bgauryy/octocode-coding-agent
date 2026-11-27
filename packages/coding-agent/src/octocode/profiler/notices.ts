import type { TranscriptRef } from "@octocodeai/octocode-contracts/team";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { EXTERNAL_MESSAGE_TYPE, INTERNAL_MESSAGE_TYPE } from "../shared/messages.ts";
import { TEAM_SENDER } from "../team/endpoint.ts";
import type { FeedNotice } from "../team/feed.ts";
import { num, str, type Entry, type Prepared } from "./entries.ts";

const entryAt = (entry: Entry): number => {
	const at = Date.parse(String(entry.timestamp));
	return Number.isFinite(at) ? at : 0;
};

/** The session id a transcript's header names, when it has one. */
export const sessionIdOf = (prepared: Prepared): string | undefined => {
	const header = prepared.entries[0];
	return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
};

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((block) => str(asRecord(block).text, "")).join("")
			: "";

/**
 * The internal notices an agent's transcript holds: `custom_message` entries of team mail that carry a message without a
 * team id (check-ins, lease and dead-letter notices) and mail from a local API client. Team messages with an id are not
 * notices: the database holds them. Read from the transcript, so nothing new is stored.
 */
export function internalNotices(agentId: string, prepared: Prepared): FeedNotice[] {
	const sessionId = sessionIdOf(prepared);
	const notices: FeedNotice[] = [];
	prepared.entries.forEach((entry, position) => {
		if (entry.type !== "custom_message") return;
		const at = entryAt(entry);
		const base = {
			agentId,
			...(sessionId ? { sessionId } : {}),
			entry: position,
			label: str(entry.customType, "notice"),
		};
		const details = asRecord(entry.details);
		if (entry.customType === INTERNAL_MESSAGE_TYPE && Array.isArray(details.messages)) {
			details.messages.forEach((item, index) => {
				const message = asRecord(item);
				if (typeof message.id === "number") return;
				notices.push({
					...base,
					entryId: `${entry.id}.${index}`,
					at: num(message.at) || at,
					from: str(message.from, TEAM_SENDER),
					text: str(message.text, ""),
				});
			});
		} else if (entry.customType === EXTERNAL_MESSAGE_TYPE) {
			const message = asRecord(details.message);
			notices.push({
				...base,
				entryId: `${entry.id}.0`,
				at: num(details.at) || at,
				from: str(details.from, "external"),
				external: true,
				text: str(message.text, textOf(entry.content)),
			});
		}
	});
	return notices;
}

/**
 * Where in `prepared` (an agent's transcript) its thinking and output near `at` are: its last assistant entry written at or
 * before `at`, which holds the reply that made the send. Undefined when it wrote none by then.
 */
export function transcriptNear(agentId: string, prepared: Prepared, at: number): TranscriptRef | undefined {
	let found: { entry: number; at: number } | undefined;
	prepared.entries.forEach((entry, position) => {
		const when = entryAt(entry);
		if (entry.type !== "message" || asRecord(entry.message).role !== "assistant" || when > at) return;
		if (!found || when >= found.at) found = { entry: position, at: when };
	});
	const sessionId = sessionIdOf(prepared);
	return found ? { agentId, ...(sessionId ? { sessionId } : {}), entry: found.entry } : undefined;
}
