import { APICallError } from "@ai-sdk/provider";
import { createStatusCodeErrorResponseHandler, postJsonToApi } from "@ai-sdk/provider-utils";
import type { ProviderRequestOptions } from "../types.ts";
import { raceWithAbortSignal } from "./abort.ts";
import { iterateSseMessages } from "./server-sent-events.ts";

/** Responses retain a whole-stream deadline; Completions end it after successful response headers. */
export async function requestJsonEventStream(
	url: URL,
	body: unknown,
	headers: Record<string, string>,
	options?: ProviderRequestOptions & { timeoutScope?: "headers" | "stream" },
): Promise<{ response: Response; events: AsyncGenerator; dispose: () => void }> {
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
		const request = postJsonToApi({
			url: url.href,
			headers,
			body,
			abortSignal: signal,
			fetch: async (input, init) => {
				// Authentication and explicit header overrides are resolved by the host.
				const received = await (options?.fetch ?? globalThis.fetch)(input, { ...init, headers });
				if (signal.aborted) {
					void received.body?.cancel().catch(() => {});
					signal.throwIfAborted();
				}
				responseForCleanup = received;
				if (received.ok && options?.timeoutScope === "headers") clearTimeout(timer);
				// SDK error handlers consume the body; keep that read abortable even with injected fetch.
				return !received.ok && received.body
					? new Response(received.body.pipeThrough(new TransformStream(), { signal }), received)
					: received;
			},
			failedResponseHandler: createStatusCodeErrorResponseHandler(),
			successfulResponseHandler: async ({ response }) => ({ value: response }),
		});
		// Custom fetch implementations may ignore the signal. Stop waiting and close any late response.
		const { value: response } = await raceWithAbortSignal(request, signal);
		if (!response.body) throw new Error("Provider returned no response body");
		return { response, events: iterateJsonEvents(response.body, signal), dispose };
	} catch (error) {
		dispose();
		if (error instanceof Error && !APICallError.isInstance(error) && !("status" in error)) {
			throw Object.assign(error, { status: undefined, headers: undefined });
		}
		throw error;
	}
}

async function* iterateJsonEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator {
	for await (const event of iterateSseMessages(body, signal)) {
		if (event.event === "error") throw new Error(event.data);
		if (event.data === "[DONE]") return;
		yield JSON.parse(event.data) as unknown;
	}
}
