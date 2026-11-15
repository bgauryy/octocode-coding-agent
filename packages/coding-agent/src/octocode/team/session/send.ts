import type { ExtensionContext } from "../../../core/features/index.ts";
import { type MessageEnvelope, USER_SENDER } from "../../shared/messages.ts";
import { visibleControls } from "../../../../../common/src/sanitize.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Mail } from "../mail.ts";
import type { DeliveryStatus, Message, SendOptions } from "../model.ts";
import { interruptRefusal, isProcessName, nextStep, outside, resolveTarget } from "../routing.ts";
import type { TeamStore } from "../store.ts";
import { patiently } from "../store/patient.ts";
import type { Vouches } from "./vouches.ts";
import { spilledMessage } from "./spilled-message.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { runnerMember } from "../runner-kind.ts";

/** What a resume carries besides the text: the stored message, so the resumed run reads it framed (`messageText`) with its id. */
export interface ResumeRequest {
	message: Message;
}

/**
 * Resumes finished subagent `to` (set by the subagents domain): `from` asks for it (the parent or the user of this
 * session; for a relay, the parent process). Its receipt, or undefined when `to` does not linger.
 */
export type Resumer = (
	to: string,
	text: string,
	from: string,
	signal?: AbortSignal,
	request?: ResumeRequest,
) => Promise<string | undefined>;

export type MessageHook = (message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal) => Promise<void>;

/** Who got a message and its id (`resumed`: a resumed subagent's receipt; `relayed`: the parent that relays it; `delivery`: how each recipient meets it), or an error text. */
export type SendResult =
	| {
			sent: string[];
			id: number;
			departed?: string[];
			/** A broadcast's children that were still starting (or writing their report): named, not reached. */
			starting?: string[];
			resumed?: string;
			relayed?: string;
			delivery?: Record<string, DeliveryStatus>;
	  }
	| { error: string };

/** What sending reads of the team (`Team`, `session.ts`): the current values each time, so a change while a hook runs is seen. */
export interface SendHost {
	me(): Member | undefined;
	ctx(): ExtensionContext | undefined;
	/** The open database, compared with the one the send started on. */
	db(): TeamStore | undefined;
	store(): TeamStore;
	parentId(): string | undefined;
	/** Subagents this session started that have finished: id → where their report went. */
	readonly finished: ReadonlyMap<string, string>;
	/** Whether subagent `id` of this session has yet to report. */
	reporting(id: string): boolean;
	/** The subagents of this session that have yet to report (a superset of `reporting`'s ids); for a broadcast's receipt. */
	starting?(): readonly string[];
	resumer(): Resumer | undefined;
	messageHook(): MessageHook | undefined;
	signed(id: number, recipient: string, text: string): string | undefined;
	signedByParent: Vouches["signedByParent"];
	readonly mail: Pick<Mail, "createdForUser">;
	runner?(id: string): { active: boolean; mail: boolean } | undefined;
}

const CHANGED = "The session or team membership changed before the message could be sent.";

/** The next step for each recipient that can no longer read: a child of this session's report and resume, else a peer's. */
const nextSteps = (host: SendHost, gone: readonly string[]): string =>
	[
		...new Set(
			gone.map((who) =>
				nextStep(who, { child: host.finished.has(who) || host.reporting(who), reported: host.finished.has(who) }),
			),
		),
	].join(" ");

/** `to` names an agent whose last run ended: the refusal says so with the next step; undefined for a name no agent had. */
function endedRefusal(host: SendHost, db: TeamStore, to: string): string | undefined {
	const run = db.presence.runs({ agentId: to, limit: 1 })[0];
	return run?.endedAt === undefined ? undefined : `${to} left the team; nothing was sent. ${nextSteps(host, [to])}`;
}

/**
 * The checks every outbound message passes, bound to the moment the send started: `check` runs the message hook for one
 * recipient and fails when the session, the membership or the database changed meanwhile; `ready` checks again before the write.
 */
export function outbound(host: SendHost, from: string, signal?: AbortSignal) {
	const db = host.store();
	const sendingContext = host.ctx();
	const sendingMember = host.me();
	// A parked child's permission check can outlive the outbound hook: keep both cancellations through resumption.
	const joined = signal
		? AbortSignal.any([signal, ...(sendingContext?.signal ? [sendingContext.signal] : [])])
		: sendingContext?.signal;
	const changed = () => host.ctx() !== sendingContext || host.me() !== sendingMember || host.db() !== db;
	const check = async (
		recipient: string,
		text: string,
		replyTo?: number,
		flags: Pick<MessageEnvelope, "replyRequired" | "wake" | "interrupt"> = {},
	): Promise<string | undefined> => {
		if (changed()) return CHANGED;
		const hook = host.messageHook();
		if (!hook || !sendingContext) return undefined;
		try {
			await hook(
				{
					channel: "internal",
					direction: "outbound",
					from,
					to: recipient,
					text,
					...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
					...flags,
				},
				sendingContext,
				joined,
			);
			joined?.throwIfAborted();
			if (changed()) throw new Error(CHANGED);
		} catch (error) {
			return errorMessage(error);
		}
		return undefined;
	};
	const ready = (): string | undefined => {
		signal?.throwIfAborted();
		if (changed()) return CHANGED;
		return sendingContext?.signal?.aborted ? errorMessage(sendingContext.signal.reason) : undefined;
	};
	return { db, signal: joined, check, ready };
}

/**
 * Resumes finished subagent `to` with a stored message (a real row, so a reply can name it): `store` records it and
 * says how to undo that when the resume does not happen. Undefined when `to` does not linger; throws what the resumer throws.
 */
export async function resumeWith(
	host: SendHost,
	to: string,
	from: string,
	store: () => { id: number; message: Message; undo: () => void },
	text: string,
	signal?: AbortSignal,
): Promise<{ id: number; resumed: string } | undefined> {
	const resumer = host.resumer();
	if (!resumer) return undefined;
	const { id, message, undo } = store();
	let resumed: string | undefined;
	try {
		resumed = await resumer(to, text, from, signal, { message });
	} catch (error) {
		undo();
		throw error;
	}
	if (!resumed) undo();
	return resumed ? { id, resumed } : undefined;
}

/** The refusal for a finished subagent that no longer lingers. */
export function finishedText(host: SendHost, to: string): string {
	if (host.runner?.(to))
		return `${to} was a one-turn vendor runner and cannot resume or receive a follow-up. Start a new runner task with the needed context (cite report:${to}).`;
	return `${to} has finished and takes no more messages; ${host.finished.get(to)} To continue its work, resume it with the agent tool (resume: ${to}); if it ran isolated, start a new agent and give it the context it needs (cite its report as report:${to}).`;
}

/**
 * Queue a message for the agents `to` resolves to; returns who got it and the message id, or an error text. A message
 * to a finished subagent of this session resumes it when it lingers; a child's message to an agent it cannot reach is
 * stored as a relay request to its parent, whose process resumes that agent with it (`team/relay.ts`).
 */
export async function sendMessage(
	host: SendHost,
	recipient: string | undefined,
	text: string,
	options: SendOptions & { from?: string | undefined; signal?: AbortSignal } = {},
): Promise<SendResult> {
	options.signal?.throwIfAborted();
	const from = options.from ?? host.me()?.id;
	if (!from) return { error: 'Join first: call `agent` type "coordinate" with action "join".' };
	const { db, signal, check, ready } = outbound(host, from, options.signal);
	const answered = options.replyTo === undefined ? undefined : db.replyTarget(options.replyTo);
	if (options.replyTo !== undefined && !answered)
		return {
			error: `No message #${options.replyTo} in this repository to reply to; omit replyTo or use the number from the message you answer. Nothing was sent.`,
		};
	// A reply goes to the sender of the message it answers unless the caller says otherwise.
	const to = recipient ?? answered?.from;
	if (to === undefined)
		return {
			error:
				'Say who to send to: `to` (an agent id, role, "parent" (your coordinator) or "all"), or `replyTo` (the message you answer). Nothing was sent.',
		};
	// A broadcast stays in the sender's session tree; the user's and an API client's in this session's tree.
	const scope = outside(from) ? host.me()?.id : from;
	if (to === "all" && !scope) return { error: "No agents in this session yet: nothing to broadcast to." };
	// A broadcast that starts every idle agent would spend a turn in each of them: name who needs to act.
	if (to === "all" && options.wake)
		return {
			error:
				'`wake` starts an idle agent\'s turn, so it needs a named recipient (an id, role or "parent", your coordinator), not "all". Nothing was sent.',
		};
	const members = db.list();
	// A stalled member (process running, silent for `STALE_MS`) is hidden but still reads its mail: its name reaches it.
	const stalled = db.list(Date.now(), true);
	// Only a message this sender received opens a route back to its author: an id alone (any message in the repository) does not.
	const answering =
		answered && options.replyTo !== undefined && db.refs.received(options.replyTo, from) ? answered.from : undefined;
	const targets = resolveTarget(members, from, to, host.parentId(), scope, stalled, answering);
	// A broadcast reaches joined members only: a child between `agent` naming it and its join has no row to deliver to.
	const known = new Set([...members, ...stalled].map((member) => member.id));
	const starting = to === "all" ? (host.starting?.() ?? []).filter((id) => id !== from && !known.has(id)) : [];
	// A message is FYI unless the sender says it needs an answer: a default that asked for answers made two agents wake each other forever.
	const replyRequired = options.replyRequired ?? false;
	// A new message to a named agent starts its turn when idle (paced on its side), so evidence it must act on does not sit
	// unread. Replies wake only an asker still waiting on them (`insertMessage`), so an acknowledgement starts no turn; a
	// broadcast would start every idle agent, and `wake: false` leaves the message for the recipient's next turn.
	const wakes = outside(from) || (options.wake ?? (to !== "all" && options.replyTo === undefined));
	// What a PreMessageSend hook sees: the question, the wake (a question wakes, and so does `wake`) and the interrupt.
	const hookFlags = {
		replyRequired,
		wake: wakes || replyRequired,
		interrupt: options.interrupt === true,
	};
	const reply = options.replyTo !== undefined ? { replyTo: options.replyTo } : {};
	// Stored with controls shown as escapes: every reader (the model, the panel, other processes) gets text that cannot steer a terminal, and the evidence stays.
	const stored = () => spilledMessage(visibleControls(text), from);
	if (typeof targets === "string") {
		const runner = host.runner?.(to);
		if (runner && (!runner.active || !runner.mail))
			return {
				error: runner.active
					? `${to} is a vendor runner without a live mailbox. Do not retry this message; wait for its report or stop the task with coordinate stop.`
					: finishedText(host, to),
			};
		if (to === "all" && starting.length > 0)
			return {
				error: `${targets} Still starting, so not reached: ${starting.join(", ")}. Nothing was sent; send again once they have joined.`,
			};
		const finished = host.finished.has(to);
		const parent = host.parentId();
		// A subagent has no route to another Octocode process; its parent has (the session API), so the parent must send it.
		if (parent !== undefined && !outside(from) && isProcessName(to))
			return {
				error: `${to} is an Octocode process, and subagents have no route to other processes: nothing was sent. Send to "parent" (your coordinator ${parent}) and ask it to message ${to}.`,
			};
		const relay =
			!finished &&
			parent !== undefined &&
			!outside(from) &&
			!["all", "parent", from].includes(to) &&
			!options.interrupt &&
			// A name some agent answers to was refused for a reason (several match, or it is outside the tree): no relay.
			![...members, ...stalled].some((member) => member.id === to || member.role === to);
		if (!(finished && host.resumer()) && !relay) {
			if (finished) return { error: finishedText(host, to) };
			// Between `agent` naming it and its joining the team, or between its leaving and its report: it is not gone.
			if (host.reporting(to))
				return {
					error: `${to} is running but cannot read messages yet: it is still starting, or already writing its report. Nothing was sent; send it again on your next step.`,
				};
			// An answer its asker can no longer read: the question closes, so it stops waiting on this agent.
			if (options.replyTo === undefined || to !== answered?.from)
				return { error: endedRefusal(host, db, to) ?? targets };
			db.refs.closeQuestion(options.replyTo, from);
			return { error: `${targets} Its question #${options.replyTo} is closed; nothing was sent.` };
		}
		const denied = (await check(to, text, options.replyTo, hookFlags)) ?? ready();
		if (denied) return { error: denied };
		const delivered = stored();
		if (typeof delivered !== "string") return delivered;
		if (relay) {
			const id = db.refs.relay(from, parent, to, delivered, { replyRequired, ...reply });
			return id === undefined
				? { error: `${targets} Your coordinator ${parent} left, so it could not be relayed. Nothing was sent.` }
				: { sent: [to], id, relayed: parent };
		}
		const resumed = await resumeWith(
			host,
			to,
			from,
			() => {
				const { id, at } = db.refs.storeResumed(from, to, delivered, { replyRequired, ...reply });
				const message = { id, from, to, text: delivered, at, replyRequired, ...reply };
				return { id, message, undo: () => db.refs.retract(id) };
			},
			text,
			signal,
		);
		return resumed ? { sent: [to], ...resumed } : { error: finishedText(host, to) };
	}
	const refused = options.interrupt ? interruptRefusal(members, targets, from, to, scope) : undefined;
	if (refused) return { error: refused };
	const runner = targets.some(runnerMember);
	if (runner && (options.interrupt || options.wake))
		return {
			error:
				"Vendor runner mail is cooperative: it cannot interrupt or wake a turn. Send without those flags, or stop the task with coordinate stop. Nothing was sent.",
		};
	for (const target of targets) {
		const denied = await check(target.id, text, options.replyTo, hookFlags);
		if (denied) return { error: denied };
	}
	const notReady = ready();
	if (notReady) return { error: notReady };
	const delivered = stored();
	if (typeof delivered !== "string") return delivered;
	// The user's messages and this session's own are signed, and only for a child this session started: any other recipient, or any other writer of the row, reads as unverified.
	const sign =
		from === USER_SENDER
			? (id: number, recipient: string) => host.signed(id, recipient, delivered)
			: from === host.me()?.id
				? (id: number, recipient: string) => host.signedByParent({ id, from, to: recipient, text: delivered })
				: undefined;
	const flags = {
		replyRequired,
		// Vendor runner mail is cooperative: it never starts a turn, so the default leaves it unflagged.
		wake: wakes && !runner,
		interrupt: options.interrupt === true,
		...reply,
		...(sign ? { sign } : {}),
	};
	// Never waits inside SQLite: while another process holds the database the send is tried again (`patiently`).
	const { id, departed, woken } = await patiently(
		db,
		() =>
			db.send(
				from,
				targets.map((target) => target.id),
				delivered,
				flags,
			),
		signal,
	);
	if (id === undefined)
		return {
			error: `${departed.join(", ")} left the team; the message was not sent. ${nextSteps(host, departed)}`,
		};
	const sent = targets.map((target) => target.id).filter((target) => !departed.includes(target));
	// How each recipient meets the message, so a sender is told when an idle FYI only waits for its next turn. A recipient
	// that got the message (its process runs) but is no longer listed has not been seen for `STALE_MS`: it may only be stalled.
	const listed = db.list();
	const listedIds = new Set(listed.map((member) => member.id));
	const working = new Set(listed.filter((member) => member.status === "working").map((member) => member.id));
	const delivery: Record<string, DeliveryStatus> = {};
	for (const recipient of sent)
		delivery[recipient] = targets.some((target) => target.id === recipient && runnerMember(target))
			? "pull"
			: !listedIds.has(recipient)
				? "stalled"
				: woken.includes(recipient)
					? "wake"
					: working.has(recipient)
						? "next-step"
						: "queued-quiet";
	if (from === USER_SENDER) host.mail.createdForUser(id, delivered, sent);
	return {
		sent,
		id,
		delivery,
		...(departed.length > 0 ? { departed } : {}),
		...(starting.length > 0 ? { starting } : {}),
	};
}
