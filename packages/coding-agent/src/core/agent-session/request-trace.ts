/**
 * Records what each provider request sent on the assistant message it produced. The trace belongs
 * to one request: `onPayload` of that call fills it, and the call's own event stream stamps it on
 * the message, so parallel requests (side questions, compaction, children) never share state.
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

function messageOf(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return "partial" in event ? event.partial : undefined;
}

/** How many conversations keep a memo of their last request's layers; the least recently described is forgotten first. */
const MEMO_CONVERSATIONS = 8;
const memos = new Map<string, PayloadLayerMemo>();

/**
 * The memo of one conversation's requests (`describePayloadLayers`): consecutive requests of a session share their
 * prefix, so only its new layers are serialized. Requests with their own routing id (compaction, summaries) keep their
 * own memo; a missing id shares one. A memo never changes a trace, only how much of it is computed again.
 */
function memoFor(sessionId: string | undefined): PayloadLayerMemo {
	const key = sessionId ?? "";
	let memo = memos.get(key);
	if (memo) memos.delete(key);
	else memo = new PayloadLayerMemo();
	memos.set(key, memo);
	if (memos.size > MEMO_CONVERSATIONS) memos.delete(memos.keys().next().value as string);
	return memo;
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
			const memo = memoFor(options.sessionId);
			trace = describePayloadLayers((model as { api: string }).api, replaced ?? payload, memo);
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
