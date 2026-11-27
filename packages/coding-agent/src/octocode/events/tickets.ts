import { createHash } from "node:crypto";
import { events, tickets, type AgentDb, type TicketRow } from "../../../../db/src/api.ts";
import { clipText } from "@octocodeai/octocode-common/clip";
import { toNewEvent, type NewAgentEvent } from "./loop/rows.ts";
import type { Source } from "./source-types.ts";
import { makeSource } from "./source.ts";
import type { Topic, TopicFilter } from "./topics.ts";

/**
 * Callback tickets: a promise across agents, beside the messages that carry the request. A request names who it asks, what
 * resolves it (`on`) and a deadline, and returns a ticket. A reply or a matching event resolves it at most once (one
 * conditional UPDATE in `packages/db`), the result is one `ticket.resolved` event in the durable log, and the requester finds
 * it there after a compaction or a resume. A result is data at the resolver's own source and trust, never authority. Nothing
 * here sends a message or wakes an agent: the live delivery path stays as it is until the cutover.
 */

type CallbackOn = "reply" | "done" | "job.exit" | "agent.ended";

/** Defaults in minutes when the caller names no deadline. */
const DEADLINE_MINUTES: Record<CallbackOn, number> = {
	reply: 10,
	done: 60,
	"job.exit": 60,
	"agent.ended": 60,
};

export const MAX_DEPTH = 3;
export const MAX_PENDING_PER_REQUESTER = 8;
export const MAX_PENDING_PER_TARGET = 8;
const MAX_TARGETS_PER_BROADCAST = 4;
/** A repeated identical request inside this window returns the open ticket. */
const DEDUPE_WINDOW_MS = 60_000;

export interface CallbackRequest {
	requester: string;
	target: string;
	text: string;
	on: CallbackOn;
	/** Fields of the resolving event's payload that must equal these (`{ job: "task-3" }`). */
	filter?: TopicFilter;
	/** The requester's own reminder, echoed back with the result. */
	note?: string;
	/** Absolute time (ms) after which the ticket is rejected as `timeout`. */
	deadline?: number;
	/** The `messages` row that carried the request: a reply to it resolves a `reply` ticket. */
	requestMessage?: number;
	/** The ticket whose request the requester is serving now: this request descends from it. */
	causedBy?: number;
}

export type RefusedReason = "depth" | "loop" | "requester-limit" | "target-limit" | "broadcast";

export type Requested =
	| { ok: true; ticket: TicketRow; reused: boolean }
	| { ok: false; reason: RefusedReason; line: string };

export interface TicketsOptions {
	workspaceId: string;
	sessionId?: string;
	now?: () => number;
}

/** What resolved a ticket: the resolver's source, kept as it is, and the one line the requester may read. */
export interface Resolution {
	source: Source;
	digest: string;
}

const TICKET_SOURCE = makeSource("system", "tickets", "db", "proven");

function textHash(request: CallbackRequest): string {
	const { requester, target, text, on, filter } = request;
	return createHash("sha1")
		.update(JSON.stringify([requester, target, text, on, filter ?? null]))
		.digest("hex");
}

const limitLine = (who: string): string =>
	`Refused: ${who} already has ${MAX_PENDING_PER_REQUESTER} pending callbacks; wait for one to resolve or cancel one.`;

const chainOf = (row: TicketRow): number[] => JSON.parse(row.chain) as number[];

/** Whether every entry of the ticket's filter equals the event's payload field. */
function filterHolds(row: TicketRow, payload: Record<string, unknown>): boolean {
	if (row.filter === "") return true;
	const filter = JSON.parse(row.filter) as TopicFilter;
	return Object.entries(filter).every(([key, value]) => payload[key] === value);
}

/** The ticket kinds an event can resolve, and the payload field naming the agent when the target matters. */
const RESOLVES: Partial<Record<Topic, { on: CallbackOn[]; agent?: string }>> = {
	"agent.report": { on: ["done"], agent: "agent" },
	"agent.ended": { on: ["done", "agent.ended"], agent: "agent" },
	"job.exit": { on: ["job.exit"] },
};

export class Tickets {
	private readonly agent: Pick<AgentDb, "db" | "transaction">;
	private readonly options: TicketsOptions;
	private readonly now: () => number;

	constructor(agent: Pick<AgentDb, "db" | "transaction">, options: TicketsOptions) {
		this.agent = agent;
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Opens a ticket, returns the open one for an identical recent request, or refuses with one line. */
	request(request: CallbackRequest): Requested {
		return this.agent.transaction(() => {
			const { db } = this.agent;
			const at = this.now();
			const workspaceId = this.options.workspaceId;
			const parent = request.causedBy === undefined ? undefined : tickets.find(db, request.causedBy);
			const depth = parent ? parent.depth + 1 : 1;
			const chain = parent ? [...chainOf(parent), parent.id] : [];
			const loop = this.loopRefusal(request, parent, depth, chain);
			if (loop) return this.refuse(request, loop.reason, loop.line);
			const hash = textHash(request);
			const earlier = tickets.openDuplicate(
				db,
				workspaceId,
				request.requester,
				request.target,
				hash,
				at - DEDUPE_WINDOW_MS,
			);
			if (earlier) return { ok: true, ticket: earlier, reused: true };
			const outcome = tickets.open(db, {
				workspaceId,
				...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
				requester: request.requester,
				target: request.target,
				onKind: request.on,
				...(request.filter === undefined ? {} : { filter: JSON.stringify(request.filter) }),
				...(request.note === undefined ? {} : { note: request.note }),
				...(request.requestMessage === undefined ? {} : { requestMessage: request.requestMessage }),
				textHash: hash,
				depth,
				chain: JSON.stringify(chain),
				deadline: request.deadline ?? at + DEADLINE_MINUTES[request.on] * 60_000,
				at,
				maxPerRequester: MAX_PENDING_PER_REQUESTER,
				maxPerTarget: MAX_PENDING_PER_TARGET,
			});
			if ("opened" in outcome) return { ok: true, ticket: outcome.opened, reused: false };
			const who = outcome.refused === "requester" ? request.requester : request.target;
			return {
				ok: false,
				reason: outcome.refused === "requester" ? "requester-limit" : "target-limit",
				line: limitLine(who),
			};
		});
	}

	/**
	 * Why a request would be refused before anything is sent (`depth`, `loop`, or the requester's pending limit); undefined when it
	 * may go. The target's limit is checked by `request`, which opens the ticket once the message has an id.
	 */
	refusal(request: Pick<CallbackRequest, "requester" | "target" | "causedBy">): string | undefined {
		const { db } = this.agent;
		const parent = request.causedBy === undefined ? undefined : tickets.find(db, request.causedBy);
		const chain = parent ? [...chainOf(parent), parent.id] : [];
		const full = { ...request, text: "", on: "reply" } as CallbackRequest;
		const nesting = this.loopRefusal(full, parent, parent ? parent.depth + 1 : 1, chain)?.line;
		if (nesting) return nesting;
		return tickets.pendingOf(db, this.options.workspaceId, request.requester) >= MAX_PENDING_PER_REQUESTER
			? limitLine(request.requester)
			: undefined;
	}

	/** The newest pending ticket asked of `agent`: the request it is serving, which a callback it makes now descends from. */
	servingNow(agent: string): number | undefined {
		return tickets
			.pendingInvolving(this.agent.db, this.options.workspaceId, agent)
			.filter((row) => row.target === agent)
			.at(-1)?.id;
	}

	/** A broadcast asks at most `MAX_TARGETS_PER_BROADCAST` agents: beyond that it is refused whole, not queued. */
	broadcastRefusal(targetCount: number): Requested | undefined {
		if (targetCount <= MAX_TARGETS_PER_BROADCAST) return undefined;
		return {
			ok: false,
			reason: "broadcast",
			line: `Refused: a callback broadcast reaches at most ${MAX_TARGETS_PER_BROADCAST} agents, not ${targetCount}.`,
		};
	}

	private loopRefusal(
		request: CallbackRequest,
		parent: TicketRow | undefined,
		depth: number,
		chain: number[],
	): { reason: RefusedReason; line: string } | undefined {
		if (depth > MAX_DEPTH)
			return {
				reason: "depth",
				line: `Refused: callbacks nest at most ${MAX_DEPTH} deep; answer the request you serve instead.`,
			};
		if (!parent || request.target === request.requester) return undefined;
		const seen = new Set<string>();
		for (const id of chain) {
			const ancestor = tickets.find(this.agent.db, id);
			if (ancestor) {
				seen.add(ancestor.requester);
				seen.add(ancestor.target);
			}
		}
		if (seen.has(request.target))
			return {
				reason: "loop",
				line: `Refused: ${request.target} is already in this callback chain; reply to it instead.`,
			};
		return undefined;
	}

	/** A loop or depth refusal leaves a `ticket.rejected` for the requester; a limit refusal is only the line. */
	private refuse(request: CallbackRequest, reason: RefusedReason, line: string): Requested {
		this.append(
			{
				topic: "ticket.rejected",
				key: `ticket:${request.requester}:${request.target}`,
				at: this.now(),
				source: TICKET_SOURCE,
				payload: {
					on: request.on,
					requester: request.requester,
					target: request.target,
					...(request.note === undefined ? {} : { note: request.note }),
					reason: "loop",
				},
				digest: line,
			},
			undefined,
		);
		return { ok: false, reason, line };
	}

	/** The result lands under the requester's session, so that session's loop finds it whichever process settled the ticket. */
	private append(event: NewAgentEvent, ticket: number | undefined, session = this.options.sessionId): number {
		const row = toNewEvent(this.options.workspaceId, session, {
			...event,
			...(ticket === undefined ? {} : { dedupeKey: `${event.topic}:${ticket}` }),
		});
		return events.append(this.agent.db, row).seq;
	}

	/** Resolves the `reply` tickets `sender`'s reply to message `replyTo` answers; returns the tickets this call resolved. */
	resolveReply(replyTo: number, sender: string, resolution: Resolution): number[] {
		return this.agent.transaction(() =>
			tickets
				.pendingFor(this.agent.db, this.options.workspaceId, sender, "reply", replyTo)
				.filter((row) => this.resolve(row, resolution))
				.map((row) => row.id),
		);
	}

	/** Resolves the pending tickets an event satisfies (`RESOLVES`); `event.source` is the resolver, kept as it is. */
	resolveEvent(event: { topic: Topic; payload: Record<string, unknown>; source: Source; digest: string }): number[] {
		const rule = RESOLVES[event.topic];
		if (!rule) return [];
		return this.agent.transaction(() => {
			const resolved: number[] = [];
			for (const on of rule.on) {
				for (const row of tickets.pendingOfKind(this.agent.db, this.options.workspaceId, on)) {
					if (rule.agent && event.payload[rule.agent] !== row.target) continue;
					if (!filterHolds(row, event.payload)) continue;
					if (this.resolve(row, { source: event.source, digest: event.digest })) resolved.push(row.id);
				}
			}
			return resolved;
		});
	}

	/** The one place a ticket settles: the UPDATE decides the winner, the winner appends the one result event. */
	private resolve(row: TicketRow, resolution: Resolution): boolean {
		const { db } = this.agent;
		const at = this.now();
		if (!tickets.settle(db, row.id, "resolved", at, null)) return false;
		const seq = this.append(
			{
				topic: "ticket.resolved",
				key: `ticket:${row.id}`,
				at,
				source: resolution.source,
				payload: {
					ticket: row.id,
					on: row.on_kind,
					requester: row.requester,
					target: row.target,
					...(row.note === "" ? {} : { note: row.note }),
					result: clipText(resolution.digest, 160),
				},
				digest: `ticket ${row.id} resolved by ${row.target} (${row.on_kind}): ${clipText(resolution.digest, 120)}`,
			},
			row.id,
			row.session_id ?? undefined,
		);
		tickets.recordResult(db, row.id, seq);
		return true;
	}

	private reject(row: TicketRow, reason: string): boolean {
		const { db } = this.agent;
		const at = this.now();
		if (!tickets.settle(db, row.id, "rejected", at, null, reason)) return false;
		const seq = this.append(
			{
				topic: "ticket.rejected",
				key: `ticket:${row.id}`,
				at,
				source: TICKET_SOURCE,
				payload: {
					ticket: row.id,
					on: row.on_kind,
					requester: row.requester,
					target: row.target,
					...(row.note === "" ? {} : { note: row.note }),
					reason,
				},
				digest: `ticket ${row.id} to ${row.target} rejected: ${reason}`,
			},
			row.id,
			row.session_id ?? undefined,
		);
		tickets.recordResult(db, row.id, seq);
		return true;
	}

	/** Rejects every pending ticket past its deadline as `timeout`; returns their ids. */
	expire(): number[] {
		return this.agent.transaction(() =>
			tickets
				.overdue(this.agent.db, this.options.workspaceId, this.now())
				.filter((row) => this.reject(row, "timeout"))
				.map((row) => row.id),
		);
	}

	/** The requester drops a pending ticket: a later matching event finds it settled and is dropped. Returns whether it was pending. */
	cancel(id: number, requester: string): boolean {
		return this.agent.transaction(() => {
			const row = tickets.find(this.agent.db, id);
			if (!row || row.requester !== requester) return false;
			return tickets.settle(this.agent.db, id, "cancelled", this.now(), null, "cancelled");
		});
	}

	/**
	 * An agent leaves: tickets asked of it are rejected as `left` so their requesters hear. Tickets it asked stay open, since a
	 * leaving session may be a resume; they end at their deadline.
	 */
	leave(agent: string): void {
		this.agent.transaction(() => {
			for (const row of tickets.pendingInvolving(this.agent.db, this.options.workspaceId, agent))
				if (row.target === agent) this.reject(row, "left");
		});
	}

	/** Whether any ticket in the workspace is pending. */
	anyPending(): boolean {
		return tickets.anyPending(this.agent.db, this.options.workspaceId);
	}

	/** The pending tickets `requester` holds, not counting those on `except` (a reply it is about to answer). */
	pendingOf(requester: string, except = ""): number {
		return tickets.pendingOf(this.agent.db, this.options.workspaceId, requester, except);
	}

	/** A report from `target` answers the `reply` tickets `requester` holds on it: they resolve once, as a reply does. */
	resolveBetween(requester: string, target: string, resolution: Resolution): number[] {
		return this.agent.transaction(() =>
			tickets
				.pendingBetween(this.agent.db, this.options.workspaceId, requester, target)
				.filter((row) => this.resolve(row, resolution))
				.map((row) => row.id),
		);
	}
}
