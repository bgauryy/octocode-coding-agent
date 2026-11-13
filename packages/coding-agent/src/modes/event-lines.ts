import { randomUUID } from "node:crypto";

/**
 * The JSON line of a wire event as pieces to write in order. By default `turn_end` and `agent_end` repeat each message a
 * `message_end` already carried (`docs/rpc.md`): a large one is serialized once, at its `message_end`, and the later
 * events write that same text again between their own pieces. So a 50 MB reply is not serialized three times, and a
 * slow reader's queue holds one copy of it, not one per event. The bytes written are exactly `JSON.stringify(event)`
 * and a newline.
 */

/** Messages shorter than this are serialized again: keeping them would save little. */
const SHARED_MIN_CHARS = 64 * 1024;

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The messages an event carries at its top level: `message`, `toolResults`, `messages`. */
function messagesOf(event: Record_): Record_[] {
	const found: Record_[] = [];
	if (isRecord(event.message)) found.push(event.message);
	for (const key of ["toolResults", "messages"]) {
		const list = event[key];
		if (Array.isArray(list)) for (const item of list) if (isRecord(item)) found.push(item);
	}
	return found;
}

/**
 * A serializer for one event stream. Serialized messages are kept from their `message_end` until the run's `agent_end`
 * (a new `agent_start` also starts over): the run's later events are the only ones that repeat them.
 */
export function createEventLines(): (event: object) => string[] {
	const nonce = randomUUID();
	let shared = new Map<object, string>();
	return (value) => {
		const event = value as Record_;
		if (event.type === "agent_start") shared = new Map();
		const pieces = linePieces(event, shared, nonce);
		if (event.type === "agent_end") shared = new Map();
		return pieces;
	};
}

function linePieces(event: Record_, shared: Map<object, string>, nonce: string): string[] {
	const messages = messagesOf(event);
	if (messages.length === 0) return [`${JSON.stringify(event)}\n`];
	const tokens = new Map<object, { token: string; json: string }>();
	for (const message of messages) {
		let json = shared.get(message);
		if (json === undefined && event.type === "message_end") {
			json = JSON.stringify(message);
			if (json.length >= SHARED_MIN_CHARS) shared.set(message, json);
		}
		// At its `message_end` a message is placed from the text just made, so it is serialized once even when small.
		if (json !== undefined && !tokens.has(message))
			tokens.set(message, { token: `"octocode-shared-${nonce}-${tokens.size}"`, json });
	}
	if (tokens.size === 0) return [`${JSON.stringify(event)}\n`];
	const text = JSON.stringify(event, (_key, item: unknown) =>
		isRecord(item) && tokens.has(item) ? tokens.get(item)!.token.slice(1, -1) : item,
	);
	// Each token stands where its message was serialized; the nonce keeps it from matching any other text.
	const places = [...tokens.values()]
		.flatMap(({ token, json }) => {
			const at: { index: number; token: string; json: string }[] = [];
			for (let index = text.indexOf(token); index >= 0; index = text.indexOf(token, index + token.length))
				at.push({ index, token, json });
			return at;
		})
		.sort((a, b) => a.index - b.index);
	// A large message is its own piece, written as it is; the text around it, and a small message, are joined.
	const pieces: string[] = [];
	let joined = "";
	let from = 0;
	for (const { index, token, json } of places) {
		joined += text.slice(from, index);
		if (json.length < SHARED_MIN_CHARS) joined += json;
		else {
			if (joined) pieces.push(joined);
			pieces.push(json);
			joined = "";
		}
		from = index + token.length;
	}
	pieces.push(`${joined}${text.slice(from)}\n`);
	return pieces;
}
