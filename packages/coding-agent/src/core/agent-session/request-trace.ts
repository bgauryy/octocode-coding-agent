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
	type RequestLayer,
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

/** What the request's conversation was built from: the messages handed to the provider and each one's session entry. */
export interface TraceSource {
	messages: readonly { role: string }[];
	/** The key (`message:<entry id>`) of the session entry whose message object this is, if any. */
	entryKeyOf(message: object): string | undefined;
}

/** Wire roles each conversation role may be sent as (a tool result is a user turn in some APIs). */
const WIRE_ROLES: Record<string, readonly string[]> = {
	user: ["user"],
	assistant: ["assistant", "model"],
	toolResult: ["toolResult", "tool", "function_call_output", "user"],
};

/** The trace source of `messages` against the session branch `entries`: a message is a session entry's when it is that entry's own object. */
export function branchTraceSource(
	messages: readonly { role: string }[],
	entries: readonly { type: string; id: string; message?: object }[],
): TraceSource {
	const keys = new Map<object, string>();
	for (const entry of entries)
		if (entry.type === "message" && entry.message) keys.set(entry.message, `message:${entry.id}`);
	return { messages, entryKeyOf: (message) => keys.get(message) };
}

const messageLayers = (trace: RequestTrace): RequestLayer[] => trace.layers.filter((layer) => layer.kind === "message");

/**
 * `final` with `entryKey` on each message layer that provably is a session entry's message: the request as built
 * (`built`, described before any payload hook ran) has one message layer per source message, the layer at the same
 * place in `final` has the same hash and role, and the source message is a session entry's own object. A hook that
 * reordered, rewrote or dropped a message changes the hash there, so that layer stays unstamped; position alone never
 * stamps.
 */
function stampEntryKeys(built: RequestTrace, final: RequestTrace, source: TraceSource): RequestTrace {
	// A system message travels as a system block, not a conversation item.
	const sent = source.messages.filter((message) => message.role !== "system");
	const before = messageLayers(built);
	if (before.length !== sent.length) return final;
	const after = messageLayers(final);
	const keys = new Map<RequestLayer, string>();
	after.forEach((layer, i) => {
		const message = sent[i];
		const was = before[i];
		const key = message && was ? source.entryKeyOf(message) : undefined;
		const roles = WIRE_ROLES[message?.role ?? ""];
		if (!key || !was || was.hash !== layer.hash || was.role !== layer.role) return;
		if (layer.role && roles && !roles.includes(layer.role)) return;
		keys.set(layer, key);
	});
	if (!keys.size) return final;
	return {
		...final,
		layers: final.layers.map((layer) => (keys.has(layer) ? { ...layer, entryKey: keys.get(layer) } : layer)),
	};
}

/**
 * Runs `start` with `options.onPayload` chained (the caller's hook runs first, and the payload it
 * returns is the one described) and returns a stream whose messages carry `requestTrace`.
 * Requests whose API has no describer pass through unchanged.
 */
export function withRequestTrace<TOptions extends Pick<SimpleStreamOptions, "onPayload" | "sessionId">>(
	options: TOptions,
	start: (options: TOptions) => AssistantMessageEventStream,
	origin?: TraceSource,
): AssistantMessageEventStream {
	let trace: RequestTrace | undefined;
	const upstream = options.onPayload;
	const source = start({
		...options,
		onPayload: async (payload, model) => {
			const api = (model as { api: string }).api;
			// Described before the hook runs (it may change the payload in place); only needed to vouch for identity.
			const built = upstream && origin ? describePayloadLayers(api, payload) : undefined;
			const replaced = await upstream?.(payload, model);
			const conversation = conversationFor(options.sessionId);
			let described = describePayloadLayers(api, replaced ?? payload, conversation.memo);
			if (origin && described) described = stampEntryKeys(built ?? described, described, origin);
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
