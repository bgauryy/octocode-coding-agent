import type { ExtensionContext } from "../../../core/extensions/index.ts";
import { type MessageEnvelope, USER_SENDER } from "../../shared/messages.ts";
import { visibleControls } from "../../shared/sanitize.ts";
import { errorMessage } from "../../shared/util.ts";
import type { Mail } from "../mail.ts";
import type { Member, SendOptions } from "../model.ts";
import { interruptRefusal, outside, resolveTarget } from "../routing.ts";
import type { TeamStore } from "../store.ts";
import { spilledMessage } from "./spilled-message.ts";

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
	resumer():
		| ((to: string, text: string, from: string, signal?: AbortSignal) => Promise<string | undefined>)
		| undefined;
	messageHook(): ((message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal) => Promise<void>) | undefined;
	signed(id: number, recipient: string, text: string): string | undefined;
	readonly mail: Pick<Mail, "createdForUser">;
}

/** Queue a message for the agents `to` resolves to; returns who got it and the message id, or an error text. */
export async function sendMessage(
	host: SendHost,
	recipient: string | undefined,
	text: string,
	options: SendOptions & { from?: string | undefined; signal?: AbortSignal } = {},
): Promise<{ sent: string[]; id: number; departed?: string[]; resumed?: string } | { error: string }> {
	options.signal?.throwIfAborted();
	const from = options.from ?? host.me()?.id;
	if (!from) return { error: 'Join first: call `agent` type "coordinate" with action "join".' };
	const db = host.store();
	const sendingContext = host.ctx();
	const sendingMember = host.me();
	const changed = () => host.ctx() !== sendingContext || host.me() !== sendingMember || host.db() !== db;
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
	const beforeSend = async (recipient: string): Promise<string | undefined> => {
		if (changed()) return "The session or team membership changed before the message could be sent.";
		const ctx = sendingContext;
		if (!host.messageHook() || !ctx) return undefined;
		const signal = options.signal ? AbortSignal.any([options.signal, ...(ctx.signal ? [ctx.signal] : [])]) : ctx.signal;
		try {
			await host.messageHook()!(
				{
					channel: "internal",
					direction: "outbound",
					from,
					to: recipient,
					text,
					...(options.replyTo !== undefined ? { replyTo: String(options.replyTo) } : {}),
				},
				ctx,
				signal,
			);
			signal?.throwIfAborted();
			if (changed()) throw new Error("The session or team membership changed before the message could be sent.");
		} catch (error) {
			return errorMessage(error);
		}
		return undefined;
	};
	if (typeof targets === "string" && host.finished.has(to) && host.resumer()) {
		const denied = await beforeSend(to);
		if (denied) return { error: denied };
		if (changed()) return { error: "The session or team membership changed before the message could be sent." };
		if (sendingContext?.signal?.aborted) return { error: errorMessage(sendingContext.signal.reason) };
	}
	const resumed =
		typeof targets === "string" && host.finished.has(to)
			? await host.resumer()?.(to, text, from, options.signal)
			: undefined;
	if (resumed) return { sent: [to], id: 0, resumed };
	if (typeof targets === "string")
		return {
			error: host.finished.has(to)
				? `${to} has finished and takes no more messages; ${host.finished.get(to)} To continue its work, start a new agent and give it the context it needs.`
				: targets,
		};
	const refused = options.interrupt ? interruptRefusal(members, targets, from, to, scope) : undefined;
	if (refused) return { error: refused };
	for (const target of targets) {
		const denied = await beforeSend(target.id);
		if (denied) return { error: denied };
	}
	options.signal?.throwIfAborted();
	if (changed()) return { error: "The session or team membership changed before the message could be sent." };
	if (sendingContext?.signal?.aborted) return { error: errorMessage(sendingContext.signal.reason) };
	// A message is FYI unless the sender says it needs an answer: a default that asked for answers made two agents wake each other forever.
	const replyRequired = options.replyRequired ?? false;
	// Stored with controls shown as escapes: every reader (the model, the panel, other processes) gets text that cannot steer a terminal, and the evidence stays.
	const delivered = spilledMessage(visibleControls(text), from);
	if (typeof delivered !== "string") return delivered;
	const reply = options.replyTo !== undefined ? { replyTo: options.replyTo } : {};
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
