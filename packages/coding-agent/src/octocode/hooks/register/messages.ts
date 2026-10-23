import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { EXTERNAL_MESSAGE_TYPE, INTERNAL_MESSAGE_TYPE, type MessageEnvelope } from "../../shared/messages.ts";
import { isRecord } from "../../shared/util.ts";
import type { Dispatch, HooksView, ReportFailure } from "./types.ts";

function receivedMessages(value: unknown): MessageEnvelope[] {
	if (!isRecord(value) || value.role !== "custom" || !isRecord(value.details)) return [];
	if (value.customType !== INTERNAL_MESSAGE_TYPE && value.customType !== EXTERNAL_MESSAGE_TYPE) return [];
	const envelope = value.details.message;
	if (
		isRecord(envelope) &&
		(envelope.channel === "internal" || envelope.channel === "external") &&
		typeof envelope.from === "string" &&
		typeof envelope.to === "string" &&
		typeof envelope.text === "string" &&
		typeof envelope.id === "string"
	) {
		return [
			{
				channel: envelope.channel,
				direction: "inbound",
				from: envelope.from,
				to: envelope.to,
				text: envelope.text,
				id: envelope.id,
				...(typeof envelope.replyTo === "string" ? { replyTo: envelope.replyTo } : {}),
			},
		];
	}
	if (value.customType !== INTERNAL_MESSAGE_TYPE || !Array.isArray(value.details.messages)) return [];
	return value.details.messages.flatMap((message): MessageEnvelope[] => {
		if (
			!isRecord(message) ||
			typeof message.id !== "number" ||
			typeof message.from !== "string" ||
			typeof message.to !== "string" ||
			typeof message.text !== "string"
		)
			return [];
		return [
			{
				channel: "internal",
				direction: "inbound",
				from: message.from,
				to: message.to,
				text: message.text,
				id: String(message.id),
				...(typeof message.replyTo === "number" ? { replyTo: String(message.replyTo) } : {}),
			},
		];
	});
}

const messageKey = (message: MessageEnvelope): string | undefined =>
	message.id === undefined
		? undefined
		: JSON.stringify([message.channel, message.direction, message.from, message.to, message.id]);
const messageNames = (message: MessageEnvelope): string[] => [
	message.channel,
	`${message.channel}.${message.direction}`,
];

/**
 * PreMessageSend gates a send; PostMessageReceive observes delivery. Tracks which session the messages belong to and
 * which were already seen (a resumed session replays its history), so each received message dispatches once.
 */
export function registerMessageHooks(
	pi: ExtensionAPI,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): Pick<HooksView, "messageSend" | "messageReceive"> {
	let messageAbort = new AbortController();
	let messageSessionId: string | undefined;
	const received = new Set<string>();
	let receivedObjects = new WeakSet<MessageEnvelope>();

	pi.on("session_start", async (_event, ctx) => {
		messageAbort.abort();
		messageAbort = new AbortController();
		messageSessionId = undefined;
		received.clear();
		receivedObjects = new WeakSet();
		try {
			messageSessionId = ctx.sessionManager.getSessionId();
			for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
				const message =
					entry.type === "message"
						? entry.message
						: entry.type === "custom_message"
							? { role: "custom", ...entry }
							: undefined;
				for (const envelope of receivedMessages(message)) {
					const key = messageKey(envelope);
					if (key) received.add(key);
				}
			}
		} catch {
			messageAbort.abort();
		}
	});
	pi.on("session_shutdown", async () => messageAbort.abort());

	const messageSend: HooksView["messageSend"] = async (message, ctx) => {
		if (ctx.sessionManager.getSessionId() !== messageSessionId)
			throw new Error("The message belongs to a different session.");
		const signal = ctx.signal ? AbortSignal.any([messageAbort.signal, ctx.signal]) : messageAbort.signal;
		signal.throwIfAborted();
		const verdict = await dispatch(ctx, "PreMessageSend", messageNames(message), () => ({ message }), signal);
		signal.throwIfAborted();
		return verdict.block
			? { block: `Blocked by a PreMessageSend hook: ${verdict.block}` }
			: verdict.ask
				? { ask: verdict.ask }
				: undefined;
	};

	const messageReceive: HooksView["messageReceive"] = async (message, ctx) => {
		const signal = messageAbort.signal;
		if (signal.aborted) return;
		try {
			if (ctx.sessionManager.getSessionId() !== messageSessionId) return;
		} catch {
			return;
		}
		const key = messageKey(message);
		if (key ? received.has(key) : receivedObjects.has(message)) return;
		if (key) received.add(key);
		else receivedObjects.add(message);
		// Observers never change the message or add a reply, even if a hook prints a gate verdict.
		await dispatch(ctx, "PostMessageReceive", messageNames(message), () => ({ message }), signal).catch(
			(error: unknown) => {
				if (!signal.aborted) reportFailure(ctx, "PostMessageReceive", error);
			},
		);
	};

	pi.on("context", async (event, ctx) => {
		const signal = messageAbort.signal;
		for (const message of event.messages) {
			for (const envelope of receivedMessages(message)) {
				if (signal.aborted) return undefined;
				await messageReceive(envelope, ctx);
			}
		}
		return undefined;
	});

	return { messageSend, messageReceive };
}

/** Notification observers outlive the foreground turn, but never their session. */
export function notificationHook(
	pi: ExtensionAPI,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): HooksView["notification"] {
	let controller = new AbortController();
	let closed = false;
	const active = new Set<Promise<void>>();
	const stop = async () => {
		closed = true;
		controller.abort();
		await Promise.allSettled(active);
	};
	pi.on("session_shutdown", stop);
	pi.on("session_start", async () => {
		await stop();
		controller = new AbortController();
		closed = false;
	});
	return (notice, ctx) => {
		if (closed) return;
		const input = {
			message: notice.message,
			...(notice.title ? { title: notice.title } : {}),
			notification_type: notice.type,
		};
		const task = dispatch(ctx, "Notification", [notice.type], () => input, controller.signal)
			.then(
				() => undefined,
				(error: unknown) => reportFailure(ctx, "Notification", error),
			)
			.finally(() => active.delete(task));
		active.add(task);
	};
}
