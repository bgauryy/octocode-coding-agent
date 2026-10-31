import type { ExtensionContext } from "../../../core/extensions/index.ts";
import { type MessageEnvelope, USER_SENDER } from "../../shared/messages.ts";
import { visibleControls } from "../../shared/sanitize.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Mail } from "../mail.ts";
import type { Message, SendOptions } from "../model.ts";
import { interruptRefusal, outside, resolveTarget } from "../routing.ts";
import type { TeamStore } from "../store.ts";
import { spilledMessage } from "./spilled-message.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

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

/** Who got a message and its id (`resumed`: a resumed subagent's receipt; `relayed`: the parent that relays it), or an error text. */
export type SendResult =
	| { sent: string[]; id: number; departed?: string[]; resumed?: string; relayed?: string }
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
	resumer(): Resumer | undefined;
	messageHook(): MessageHook | undefined;
	signed(id: number, recipient: string, text: string): string | undefined;
	readonly mail: Pick<Mail, "createdForUser">;
}

const CHANGED = "The session or team membership changed before the message could be sent.";

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
	const check = async (recipient: string, text: string, replyTo?: number): Promise<string | undefined> => {
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
	return `${to} has finished and takes no more messages; ${host.finished.get(to)} To continue its work, start a new agent and give it the context it needs (cite its report as report:${to}).`;
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
				'Say who to send to: `to` (an agent id, role, "parent" or "all"), or `replyTo` (the message you answer). Nothing was sent.',
		};
	// A broadcast stays in the sender's session tree; the user's and an API client's in this session's tree.
	const scope = outside(from) ? host.me()?.id : from;
	if (to === "all" && !scope) return { error: "No agents in this session yet: nothing to broadcast to." };
	const members = db.list();
	const targets = resolveTarget(members, from, to, host.parentId(), scope);
	// A message is FYI unless the sender says it needs an answer: a default that asked for answers made two agents wake each other forever.
	const replyRequired = options.replyRequired ?? false;
	const reply = options.replyTo !== undefined ? { replyTo: options.replyTo } : {};
	// Stored with controls shown as escapes: every reader (the model, the panel, other processes) gets text that cannot steer a terminal, and the evidence stays.
	const stored = () => spilledMessage(visibleControls(text), from);
	if (typeof targets === "string") {
		const finished = host.finished.has(to);
		const parent = host.parentId();
		const relay =
			!finished &&
			parent !== undefined &&
			!outside(from) &&
			!["all", "parent", from].includes(to) &&
			!options.interrupt &&
			members.filter((member) => member.role === to).length < 2;
		if (!(finished && host.resumer()) && !relay) return { error: finished ? finishedText(host, to) : targets };
		const denied = (await check(to, text, options.replyTo)) ?? ready();
		if (denied) return { error: denied };
		const delivered = stored();
		if (typeof delivered !== "string") return delivered;
		if (relay) {
			const id = db.refs.relay(from, parent, to, delivered, { replyRequired, ...reply });
			return id === undefined
				? { error: `${targets} Your parent ${parent} left, so it could not be relayed. Nothing was sent.` }
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
	for (const target of targets) {
		const denied = await check(target.id, text, options.replyTo);
		if (denied) return { error: denied };
	}
	const notReady = ready();
	if (notReady) return { error: notReady };
	const delivered = stored();
	if (typeof delivered !== "string") return delivered;
	// Only the user's messages are signed, and only for a child this session started: any other recipient reads them as unverified.
	const sign =
		from === USER_SENDER ? (id: number, recipient: string) => host.signed(id, recipient, delivered) : undefined;
	const flags = {
		replyRequired,
		wake: outside(from),
		interrupt: options.interrupt === true,
		...reply,
		...(sign ? { sign } : {}),
	};
	const { id, departed } = db.send(
		from,
		targets.map((target) => target.id),
		delivered,
		flags,
	);
	if (id === undefined) return { error: `${departed.join(", ")} left the team; the message was not sent.` };
	const sent = targets.map((target) => target.id).filter((target) => !departed.includes(target));
	if (from === USER_SENDER) host.mail.createdForUser(id, delivered, sent);
	return { sent, id, ...(departed.length > 0 ? { departed } : {}) };
}
