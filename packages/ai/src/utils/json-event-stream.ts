import type { ProviderRequestOptions } from "../types.ts";
import { raceWithAbortSignal } from "./abort.ts";

/** A request attempt owns its timeout until the caller finishes consuming the stream. */
export async function requestJsonEventStream(
	url: URL,
	body: unknown,
	headers: Record<string, string>,
	options?: ProviderRequestOptions,
): Promise<{ response: Response; events: AsyncGenerator<unknown>; dispose: () => void }> {
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(
		() => controller.abort(new Error("Provider request timed out")),
		options?.timeoutMs ?? 600_000,
	);
	let responseForCleanup: Response | undefined;
	const dispose = () => {
		clearTimeout(timer);
		controller.abort();
		if (responseForCleanup?.body && !responseForCleanup.body.locked)
			void responseForCleanup.body.cancel().catch(() => {});
	};
	try {
		signal.throwIfAborted();
		const pendingResponse = (options?.fetch ?? globalThis.fetch)(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		// Custom fetch implementations may ignore the signal. Stop waiting and close any late response.
		const response = await raceWithAbortSignal<Response>(
			pendingResponse.then((received) => {
				if (signal.aborted) {
					void received.body?.cancel().catch(() => {});
					signal.throwIfAborted();
				}
				return received;
			}),
			signal,
		);
		responseForCleanup = response;
		if (!response.ok) {
			const body = await raceWithAbortSignal(response.text(), signal);
			throw Object.assign(new Error(`HTTP ${response.status}: ${body}`), {
				status: response.status,
				headers: response.headers,
				body,
			});
		}
		if (!response.body) throw new Error("Provider returned no response body");
		return { response, events: iterateJsonEvents(response.body, signal), dispose };
	} catch (error) {
		dispose();
		if (error instanceof Error && !("status" in error)) {
			throw Object.assign(error, { status: undefined, headers: undefined });
		}
		throw error;
	}
}

async function* iterateJsonEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let eventName = "";
	let eof = false;
	try {
		while (!eof) {
			const chunk = await raceWithAbortSignal(reader.read(), signal);
			eof = chunk.done;
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			// Flush a final event even when a compatible server omits its terminating blank line.
			if (eof) buffer += "\n\n";
			for (;;) {
				const end = buffer.search(/[\r\n]/);
				if (end < 0 || (!eof && end === buffer.length - 1 && buffer[end] === "\r")) break;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
				if (line === "") {
					if (data.length === 0) {
						eventName = "";
						continue;
					}
					const payload = data.join("\n");
					data = [];
					if (eventName === "error") throw new Error(payload);
					eventName = "";
					if (payload === "[DONE]") return;
					yield JSON.parse(payload) as unknown;
				} else if (line === "data" || line.startsWith("data:")) {
					data.push(line.slice(5).replace(/^ /, ""));
				} else if (line.startsWith("event:")) {
					eventName = line.slice(6).replace(/^ /, "");
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
