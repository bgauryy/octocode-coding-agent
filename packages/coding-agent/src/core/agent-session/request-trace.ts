/**
 * Records what each provider request sent on the assistant message it produced. The trace belongs
 * to one request: `onPayload` of that call fills it, and the call's own event stream stamps it on
 * the message, so parallel requests (side questions, compaction, children) never share state. Each trace is chained to
 * the previous one of its conversation (`trace-chain.ts`), so the messages of a session hold each layer about once.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	describePayloadLayers,
	PayloadLayerMemo,
	type RequestTrace,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { chainTrace } from "../session-manager/trace-chain.ts";

function messageOf(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return "partial" in event ? event.partial : undefined;
}

/** How many conversations keep a memo of their last request's layers; the least recently described is forgotten first. */
const MEMO_CONVERSATIONS = 8;

interface Conversation {
	memo: PayloadLayerMemo;
	/** The trace of the conversation's last described request: the next one extends its chain. */
	last?: RequestTrace;
}

const conversations = new Map<string, Conversation>();

/**
 * The memo of one conversation's requests (`describePayloadLayers`): consecutive requests of a session share their
 * prefix, so only its new layers are serialized. Requests with their own routing id (compaction, summaries) keep their
 * own memo; a missing id shares one. A memo never changes a trace, only how much of it is computed again.
 */
function conversationFor(sessionId: string | undefined): Conversation {
	const key = sessionId ?? "";
	let conversation = conversations.get(key);
	if (conversation) conversations.delete(key);
	else conversation = { memo: new PayloadLayerMemo() };
	conversations.set(key, conversation);
	if (conversations.size > MEMO_CONVERSATIONS) conversations.delete(conversations.keys().next().value as string);
	return conversation;
}

/**
 * Runs `start` with `options.onPayload` chained (the caller's hook runs first, and the payload it
 * returns is the one described) and returns a stream whose messages carry `requestTrace`.
 * Requests whose API has no describer pass through unchanged.
 */
export function withRequestTrace<TOptions extends Pick<SimpleStreamOptions, "onPayload" | "sessionId">>(
	options: TOptions,
	start: (options: TOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	let trace: RequestTrace | undefined;
	const upstream = options.onPayload;
	const source = start({
		...options,
		onPayload: async (payload, model) => {
			const replaced = await upstream?.(payload, model);
			const conversation = conversationFor(options.sessionId);
			const described = describePayloadLayers((model as { api: string }).api, replaced ?? payload, conversation.memo);
			trace = described && chainTrace(described, conversation.last);
			if (trace) conversation.last = trace;
			return replaced;
		},
	});
	const traced = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				const message = messageOf(event);
				if (trace && message) message.requestTrace = trace;
				traced.push(event);
			}
		} finally {
			traced.end();
			// A provider may finish with `end(result)` and no done event: forward that result too, or callers wait forever.
			void source.result().then((message) => {
				if (trace) message.requestTrace ??= trace;
				traced.end(message);
			});
		}
	})();
	return traced;
}
