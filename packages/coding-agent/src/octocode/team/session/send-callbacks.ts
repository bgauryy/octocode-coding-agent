import { clipText } from "@octocodeai/octocode-common/clip";
import { makeSource } from "../../events/source.ts";
import type { CallbackRequest } from "../../events/tickets.ts";
import type { CallbackSpec, SendOptions } from "../model.ts";
import type { TeamStore } from "../store.ts";

/**
 * The callback a send carries (`events/tickets.ts`): beside the message, never instead of it. `replyRequired` is sugar for
 * `callback { on: "reply" }` that never blocks the send; an explicit `callback` is refused, with the reason, before anything
 * is sent. A reply to a message resolves the asker's ticket once.
 */
export interface SendCallbacks {
	/** Why an explicit callback cannot be opened for these recipients; undefined when the send may go. */
	refusal(targets: readonly string[]): string | undefined;
	/** After the message is stored as `id` for `targets`: opens the tickets it asks for and resolves the ones it answers. */
	sent(id: number, targets: readonly string[]): number[];
}

const MINUTE_MS = 60_000;

export function sendCallbacks(
	db: TeamStore,
	from: string,
	options: Pick<SendOptions, "callback" | "replyTo">,
	replyRequired: boolean,
	text: string,
	now = Date.now,
): SendCallbacks {
	const spec: CallbackSpec | undefined = options.callback ?? (replyRequired ? { on: "reply" } : undefined);
	const explicit = options.callback !== undefined;
	const request = (target: string, requestMessage: number): CallbackRequest => {
		const causedBy = db.callbacks.tickets().servingNow(from);
		return {
			requester: from,
			target,
			text,
			on: spec?.on ?? "reply",
			requestMessage,
			...(spec?.filter ? { filter: spec.filter } : {}),
			...(spec?.note ? { note: spec.note } : {}),
			...(spec?.timeoutMinutes ? { deadline: now() + spec.timeoutMinutes * MINUTE_MS } : {}),
			...(causedBy === undefined ? {} : { causedBy }),
		};
	};
	return {
		refusal(targets) {
			if (!explicit) return undefined;
			const tickets = db.callbacks.tickets();
			const broadcast = targets.length > 1 ? tickets.broadcastRefusal(targets.length) : undefined;
			if (broadcast && !broadcast.ok) return `${broadcast.line} Nothing was sent.`;
			for (const target of targets) {
				const line = tickets.refusal(request(target, 0));
				if (line) return `${line} Nothing was sent.`;
			}
			return undefined;
		},
		sent(id, targets) {
			const tickets = db.callbacks.tickets();
			if (options.replyTo !== undefined)
				tickets.resolveReply(options.replyTo, from, {
					source: makeSource("peer", from, "db", "self-reported"),
					digest: clipText(text, 160),
				});
			if (!spec) return [];
			const opened: number[] = [];
			for (const target of targets) {
				// Sugar never blocks a send that was accepted: a refused ticket leaves the question as it was.
				const result = tickets.request(request(target, id));
				if (result.ok) opened.push(result.ticket.id);
			}
			return opened;
		},
	};
}
