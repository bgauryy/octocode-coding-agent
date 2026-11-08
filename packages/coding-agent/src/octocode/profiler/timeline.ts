import type { ProfileEvent, ProfileMessage, ProfileTimeline } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { Traffic } from "@octocodeai/octocode-contracts/team";
import { num, str, type Entry, type Prepared } from "./entries.ts";

/** A gap between a lane's events longer than this is an `idle` span. */
const IDLE_GAP_MS = 60_000;
/** Events returned per call; `hasMore` says the rest follows with `since` set to `until`. */
const MAX_EVENTS = 2000;
const PREVIEW_CHARS = 120;
/** The `label` of a `wait` span that is a permission ask waiting for the user. */
export const PERMISSION_WAIT_LABEL = "permission";

/** One agent as the timeline reads it: its team row facts and its parsed transcript when it has one. */
export interface Lane {
	id: string;
	parentId?: string;
	/** When it joined the team (epoch ms) and, once its run ended, when and how. */
	joinedAt?: number;
	endedAt?: number;
	outcome?: string;
	prepared?: Prepared;
}

const entryAt = (entry: Entry): number => {
	const at = Date.parse(String(entry.timestamp));
	return Number.isFinite(at) ? at : 0;
};

const sizeOf = (value: unknown): number =>
	Math.ceil((typeof value === "string" ? value : JSON.stringify(value ?? "")).length / 4);

/** Events a transcript holds: requests, tool calls (start to result), interrupts, steers, notices, compactions, permission asks. */
function transcriptEvents(agentId: string, prepared: Prepared): ProfileEvent[] {
	const events: ProfileEvent[] = [];
	const requestIndex = new Map(prepared.requests.map((position, index) => [position, index]));
	prepared.entries.forEach((entry, position) => {
		const id = (kind: string) => `${agentId}:${kind}:${entry.id}`;
		const at = entryAt(entry);
		const message = asRecord(entry.message);
		if (entry.type === "message" && message.role === "assistant") {
			const index = requestIndex.get(position);
			if (index === undefined) return;
			const usage = asRecord(message.usage);
			const duration = num(message.durationMs);
			const stop = str(message.stopReason, "");
			events.push({
				id: id("request"),
				agentId,
				kind: "request",
				at: at - duration,
				...(duration ? { durationMs: duration } : {}),
				label: str(message.model, "request"),
				outcome: stop === "error" ? "error" : stop === "aborted" ? "aborted" : "ok",
				tokens: num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite),
				ref: { request: index, entry: position },
			});
		} else if (entry.type === "message" && message.role === "toolResult") {
			const duration = num(message.durationMs);
			events.push({
				id: id("tool"),
				agentId,
				kind: "tool",
				at: at - duration,
				...(duration ? { durationMs: duration } : {}),
				label: str(message.toolName, "tool").slice(0, 60),
				outcome: message.isError === true ? "error" : "ok",
				tokens: sizeOf(message.content),
				ref: { entry: position },
			});
		} else if (entry.type === "message" && message.role === "user") {
			const origin = str(entry.origin ?? message.origin, "typed");
			if (origin === "steer" || origin === "follow-up")
				events.push({
					id: id("steer"),
					agentId,
					kind: "steer",
					at,
					label: origin,
					peer: "user",
					ref: { entry: position },
				});
		} else if (entry.type === "custom_message") {
			events.push({
				id: id("notice"),
				agentId,
				kind: "notice",
				at,
				label: str(entry.customType, "notice").slice(0, 60),
				ref: { entry: position },
			});
		} else if (entry.type === "compaction") {
			events.push({
				id: id("compaction"),
				agentId,
				kind: "compaction",
				at,
				label: "compaction",
				tokens: sizeOf(entry.summary),
				ref: { entry: position },
			});
		} else if (entry.type === "custom" && entry.customType === "octocode-interrupt") {
			const data = asRecord(entry.data);
			const reason =
				typeof data.reason === "string" && /^[a-z][a-z_-]{0,23}$/.test(data.reason) ? `: ${data.reason}` : "";
			events.push({
				id: id("interrupt"),
				agentId,
				kind: "interrupt",
				at: num(data.at) || at,
				label: `interrupt${reason}`,
				outcome: "aborted",
				ref: { entry: position },
			});
		} else if (entry.type === "custom" && entry.customType === "octocode-permission") {
			const data = asRecord(entry.data);
			events.push({
				id: id("permission"),
				agentId,
				kind: "permission",
				at: num(data.at) || at,
				label: `permission: ${str(data.action, "ask").slice(0, 30)}`,
				ref: { entry: position },
			});
			// The ask's dialog was open from `askedAt` until the entry was written at the decision.
			const waited = num(data.at) - num(data.askedAt);
			if (num(data.askedAt) > 0 && waited > 0)
				events.push({
					id: id("wait:permission"),
					agentId,
					kind: "wait",
					at: num(data.askedAt),
					durationMs: waited,
					label: PERMISSION_WAIT_LABEL,
					ref: { entry: position },
				});
		}
	});
	return events;
}

/** `idle` spans: where nothing ran in a lane for longer than `IDLE_GAP_MS` (the lane's furthest end so far counts). */
function idleSpans(agentId: string, events: ProfileEvent[]): ProfileEvent[] {
	const spans: ProfileEvent[] = [];
	let reach = 0;
	for (const event of [...events].sort((a, b) => a.at - b.at)) {
		if (event.kind === "wait" || event.kind === "idle") continue;
		if (reach && event.at - reach > IDLE_GAP_MS)
			spans.push({
				id: `${agentId}:idle:${reach}`,
				agentId,
				kind: "idle",
				at: reach,
				durationMs: event.at - reach,
				label: "idle",
			});
		reach = Math.max(reach, event.at + (event.durationMs ?? 0));
	}
	return spans;
}

function preview(text: string): string {
	const first = text.split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS - 1)}…` : first;
}

/** The team's messages as the profiler lists them; `answeredMs` is the time to the message that replied to it. */
function profileMessages(traffic: readonly Traffic[]): ProfileMessage[] {
	const reply = new Map<number, number>();
	for (const message of traffic)
		if (message.replyTo !== undefined && !reply.has(message.replyTo)) reply.set(message.replyTo, message.at);
	return traffic.map((message) => {
		const answered = reply.get(message.id);
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
		};
	});
}

/** Message events on both lanes (`sent` and `received`) and `wait` spans of a sender that waits for a reply. */
function messageEvents(messages: readonly ProfileMessage[], lanes: ReadonlySet<string>, now: number): ProfileEvent[] {
	const events: ProfileEvent[] = [];
	for (const message of messages) {
		const outcome = message.state === "dead-lettered" ? ("error" as const) : undefined;
		for (const peer of message.to) {
			const ref = { message: message.id };
			if (lanes.has(message.from))
				events.push({
					id: `${message.from}:message:${message.id}:${peer}:sent`,
					agentId: message.from,
					kind: "message",
					at: message.at,
					label: `message to ${peer}`,
					peer,
					direction: "sent",
					...(outcome ? { outcome } : {}),
					ref,
				});
			if (lanes.has(peer))
				events.push({
					id: `${peer}:message:${message.id}:received`,
					agentId: peer,
					kind: "message",
					at: message.at,
					label: `message from ${message.from}`,
					peer: message.from,
					direction: "received",
					...(outcome ? { outcome } : {}),
					ref,
				});
		}
		const waiting = message.state === "awaiting reply" || message.answeredMs !== undefined;
		if (waiting && lanes.has(message.from))
			events.push({
				id: `${message.from}:wait:${message.id}`,
				agentId: message.from,
				kind: "wait",
				at: message.at,
				durationMs: message.answeredMs ?? Math.max(0, now - message.at),
				label: "reply wait",
				peer: message.to[0],
				ref: { message: message.id },
			});
	}
	return events;
}

export interface TimelineInput {
	sessionId: string;
	lanes: Lane[];
	traffic: readonly Traffic[];
	now: number;
}

/** Everything on the timeline, oldest first: transcript events, lifecycle, messages, waits and idle gaps. */
export function allEvents(input: TimelineInput): { events: ProfileEvent[]; messages: ProfileMessage[] } {
	const ids = new Set(input.lanes.map((lane) => lane.id));
	const messages = profileMessages(input.traffic);
	const events: ProfileEvent[] = [];
	for (const lane of input.lanes) {
		const own = lane.prepared ? transcriptEvents(lane.id, lane.prepared) : [];
		if (lane.joinedAt && lane.parentId)
			own.push({
				id: `${lane.id}:spawn`,
				agentId: lane.id,
				kind: "spawn",
				at: lane.joinedAt,
				label: "spawned",
				peer: lane.parentId,
			});
		if (lane.endedAt && lane.outcome)
			own.push({
				id: `${lane.id}:exit`,
				agentId: lane.id,
				kind: "exit",
				at: lane.endedAt,
				label: lane.outcome,
				outcome: lane.outcome === "done" ? "ok" : "error",
			});
		events.push(...own, ...idleSpans(lane.id, own));
	}
	events.push(...messageEvents(messages, ids, input.now));
	return { events: events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), messages };
}

/** `GET <profiler>/timeline?since=`: events after `since`, at most `MAX_EVENTS`. */
export function deriveTimeline(input: TimelineInput, since = 0): ProfileTimeline {
	const { events, messages } = allEvents(input);
	const fresh = events.filter((event) => event.at > since);
	const page = fresh.slice(0, MAX_EVENTS);
	return {
		sessionId: input.sessionId,
		events: page,
		messages: messages.filter((message) => message.at > since),
		until: page.at(-1)?.at ?? since,
		hasMore: fresh.length > page.length,
	};
}
