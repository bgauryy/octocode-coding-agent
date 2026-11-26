import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { isCredentialError } from "../utils/credential-errors.ts";

/** One attempt of a chat request: its events and, for a cached credential, how to drop it. */
export interface RenewableAttempt {
	events: AsyncIterable<AssistantMessageEvent>;
	renew?: () => void;
}

/** A refusal of the credential itself (401, an invalid or expired key), before the reply produced anything. */
function refusedBeforeOutput(event: AssistantMessageEvent): boolean {
	return (
		event.type === "error" &&
		event.reason === "error" &&
		event.error.content.length === 0 &&
		isCredentialError(event.error.errorMessage ?? "")
	);
}

/**
 * Streams `attempt()`. When its credential can be renewed and the provider refuses it before any output, the credential
 * is dropped and the request runs once more with a freshly resolved one; the first attempt's events are not shown.
 */
export function withCredentialRenewal(
	attempt: () => Promise<RenewableAttempt>,
): AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage | undefined> } {
	// A stream that ends with a result and no events (`AssistantMessageEventStream.end(message)`) still reports it.
	let last: RenewableAttempt | undefined;
	const tracked = async () => (last = await attempt());
	return {
		[Symbol.asyncIterator]: () => renewing(tracked),
		result: async () => {
			const events = last?.events as { result?: () => Promise<AssistantMessage> } | undefined;
			return events?.result?.();
		},
	};
}

async function* renewing(attempt: () => Promise<RenewableAttempt>): AsyncGenerator<AssistantMessageEvent> {
	const first = await attempt();
	if (!first.renew) {
		yield* first.events;
		return;
	}
	const held: AssistantMessageEvent[] = [];
	const iterator = first.events[Symbol.asyncIterator]();
	for (;;) {
		const next = await iterator.next();
		if (next.done) {
			yield* held;
			return;
		}
		const event = next.value;
		if (event.type === "start") {
			held.push(event);
			continue;
		}
		if (refusedBeforeOutput(event)) {
			await iterator.return?.();
			first.renew();
			yield* (await attempt()).events;
			return;
		}
		yield* held;
		yield event;
		break;
	}
	for (;;) {
		const next = await iterator.next();
		if (next.done) return;
		yield next.value;
	}
}
