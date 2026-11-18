import type { ProfileMessage } from "@octocodeai/octocode-contracts/profiler";
import type { Traffic } from "@octocodeai/octocode-contracts/team";
import { type EndpointDirectory, withEndpoints } from "../team/endpoint.ts";
import { noticeEntry } from "../team/feed.ts";
import type { Prepared } from "./entries.ts";
import { internalNotices, transcriptNear } from "./notices.ts";

const PREVIEW_CHARS = 120;

function preview(text: string): string {
	const first = text.split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS - 1)}…` : first;
}

/** What the messages of a timeline are read against: the agents' transcripts and how endpoints resolve. */
export interface MessageContext {
	lanes: ReadonlyArray<{ id: string; prepared?: Prepared }>;
	/** Without it messages carry no endpoints. */
	endpoints?: EndpointDirectory;
}

/** A stable negative id for a notice: notices have no team id, and a team id is never negative. */
function noticeId(key: string, taken: ReadonlySet<number>): number {
	let hash = 0x811c9dc5;
	for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
	let id = -(1 + (hash % 0x7fffffff));
	while (taken.has(id)) id -= 1;
	return id;
}

/** The team's messages as the profiler lists them; `answeredMs` is the time to the message that replied to it. */
function trafficMessages(traffic: readonly Traffic[], context: MessageContext): ProfileMessage[] {
	const reply = new Map<number, number>();
	for (const message of traffic)
		if (message.replyTo !== undefined && !reply.has(message.replyTo)) reply.set(message.replyTo, message.at);
	const prepared = new Map(context.lanes.map((lane) => [lane.id, lane.prepared]));
	return traffic.map((original) => {
		const message = context.endpoints ? withEndpoints(original, context.endpoints) : original;
		const answered = reply.get(message.id);
		const senderTranscript = prepared.get(message.from);
		const transcript = senderTranscript ? transcriptNear(message.from, senderTranscript, message.at) : undefined;
		return {
			id: message.id,
			from: message.from,
			to: message.to,
			at: message.at,
			...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
			state: message.state,
			preview: preview(message.text),
			text: message.text,
			...(message.deliveredAt === undefined ? {} : { deliveredMs: Math.max(0, message.deliveredAt - message.at) }),
			...(answered === undefined ? {} : { answeredMs: Math.max(0, answered - message.at) }),
			...(message.dropped === undefined ? {} : { dropped: message.dropped }),
			...(message.deliveries ? { deliveries: message.deliveries } : {}),
			...(message.fromEndpoint ? { fromEndpoint: message.fromEndpoint } : {}),
			...(message.toEndpoints ? { toEndpoints: message.toEndpoints } : {}),
			...(transcript ? { transcript } : {}),
		};
	});
}

/** The internal notices the lanes' transcripts hold, as messages flagged `internal` with negative ids. */
function noticeMessages(context: MessageContext, taken: Set<number>): ProfileMessage[] {
	const directory = context.endpoints ?? { members: [] };
	const messages: ProfileMessage[] = [];
	for (const lane of context.lanes) {
		if (!lane.prepared) continue;
		for (const notice of internalNotices(lane.id, lane.prepared)) {
			const entry = noticeEntry(notice, directory);
			const id = noticeId(entry.key, taken);
			taken.add(id);
			messages.push({
				id,
				from: entry.from.id,
				to: entry.to.map((end) => end.id),
				at: entry.at,
				state: "delivered",
				preview: preview(entry.text),
				text: entry.text,
				...(context.endpoints ? { fromEndpoint: entry.from, toEndpoints: entry.to } : {}),
				internal: true,
				label: notice.label,
				...(entry.transcript ? { transcript: entry.transcript } : {}),
			});
		}
	}
	return messages;
}

/** Team messages, then internal notices; each list is in the order its source gave. */
export function profileMessages(traffic: readonly Traffic[], context: MessageContext): ProfileMessage[] {
	return [...trafficMessages(traffic, context), ...noticeMessages(context, new Set())];
}
