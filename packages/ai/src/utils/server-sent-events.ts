import { EventSourceParserStream } from "@ai-sdk/provider-utils";
import { raceWithAbortSignal } from "./abort.ts";

export interface ServerSentEvent {
	event: string | null;
	data: string;
}

/**
 * Fails on an `event: error` frame, whose data is the endpoint's own failure text rather than a payload. Every JSON
 * stream reader calls this before parsing a frame, except the Codex one: Codex errors are `{"type":"error",...}`
 * payloads (also on a frame named `error`), and its event mapper turns them into errors that keep their `code`.
 */
export function throwOnSseErrorEvent(event: ServerSentEvent): void {
	if (event.event === "error") throw new Error(event.data.trim() || "Stream reported an error");
}

/**
 * Vercel AI SDK owns SSE framing and field parsing; TextDecoder handles incremental UTF-8.
 * Some compatible endpoints omit the final blank line, so finish that frame at EOF.
 * Cancellation and early iterator disposal remain owned by the request adapter.
 *
 * The body is read here and written into the parser, not piped: a pipe keeps its own read of the body pending, and
 * when the consumer stops early that read rejects with `undefined` where nothing observes it (one unhandled rejection
 * per early exit on a fetch body). The pump below awaits every read itself, so a read cut short by the cancel is caught.
 */
export async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const decoder = new TextDecoder();
	const parser = new EventSourceParserStream({ maxBufferSize: 16 * 1024 * 1024 });
	const writer = parser.writable.getWriter();
	const events = parser.readable.getReader();
	const source = body.getReader();
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await source.read();
				if (done) {
					await writer.write(`${decoder.decode()}\n\n`);
					await writer.close();
					return;
				}
				await writer.write(decoder.decode(value, { stream: true }));
			}
		} catch (error) {
			await writer.abort(error).catch(() => {});
		}
	})();
	try {
		while (true) {
			signal?.throwIfAborted();
			const { value, done } = await raceWithAbortSignal(events.read(), signal);
			signal?.throwIfAborted();
			if (done) return;
			yield { event: value.event ?? null, data: value.data };
		}
	} finally {
		await source.cancel().catch(() => {});
		source.releaseLock();
		await events.cancel().catch(() => {});
		events.releaseLock();
		await pump;
	}
}
