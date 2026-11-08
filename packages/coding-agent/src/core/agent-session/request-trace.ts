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
	type RequestTrace,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";

function messageOf(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return "partial" in event ? event.partial : undefined;
}

/**
 * Runs `start` with `options.onPayload` chained (the caller's hook runs first, and the payload it
 * returns is the one described) and returns a stream whose messages carry `requestTrace`.
 * Requests whose API has no describer pass through unchanged.
 */
export function withRequestTrace<TOptions extends Pick<SimpleStreamOptions, "onPayload">>(
	options: TOptions,
	start: (options: TOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	let trace: RequestTrace | undefined;
	const upstream = options.onPayload;
	const source = start({
		...options,
		onPayload: async (payload, model) => {
			const replaced = await upstream?.(payload, model);
			trace = describePayloadLayers((model as { api: string }).api, replaced ?? payload);
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
