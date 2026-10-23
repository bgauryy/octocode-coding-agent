import { DEFAULT_MAX_MESSAGE_BYTES } from "../transport.ts";

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface ConsumeSseOptions {
	maxEventBytes?: number;
	onEvent(event: SseEvent): void;
	/** Called for every `id` field, including events without data (for example resumption priming events). */
	onId?(id: string): void;
	/** Called for every valid `retry` field, in milliseconds. */
	onRetry?(delayMs: number): void;
	/** Stops reading and cancels the body, for example when the request this stream answers was cancelled. */
	signal?: AbortSignal;
}

export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader();
	const onAbort = () => void reader.cancel().catch(() => {});
	if (options.signal?.aborted) onAbort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let finished = false;
	const decoder = new TextDecoder();
	let buffered = "";
	let eventName: string | undefined;
	let eventId: string | undefined;
	let dataLines: string[] = [];
	// Bytes of the pending event's data, including the "\n" joins, so events streamed as many
	// short `data:` lines without a terminating blank line cannot grow without bound.
	let dataBytes = 0;
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = undefined;
			eventId = undefined;
			return;
		}
		const data = dataLines.join("\n");
		options.onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
		eventName = undefined;
		eventId = undefined;
		dataLines = [];
		dataBytes = 0;
	};

	const processLine = (rawLine: string) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
			if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
			dataLines.push(value);
		} else if (field === "event") eventName = value;
		else if (field === "id" && !value.includes("\0")) {
			eventId = value;
			options.onId?.(value);
		} else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				processLine(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
			if (Buffer.byteLength(buffered) > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		buffered += decoder.decode();
		if (buffered) processLine(buffered);
		dispatch();
		finished = true;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		// Stopping early (an error, a rejected event) must release the body and its connection.
		if (!finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export interface StreamCursor {
	lastEventId: string | undefined;
	retryMs: number | undefined;
	/** Whether the stream delivered any event since it was (re)opened. */
	received: boolean;
}
