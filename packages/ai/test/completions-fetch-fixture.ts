import { afterEach, beforeEach, vi } from "vitest";

/** Encode provider fixtures on the wire so tests exercise the real Vercel HTTP/SSE path. */
export function completionsResponse(chunks: AsyncIterable<unknown> | Iterable<unknown>): Response {
	const iterator = (async function* () {
		yield* chunks;
	})();
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done } = await iterator.next();
					if (done) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					} else controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
				} catch (error) {
					controller.error(error);
				}
			},
			async cancel() {
				await iterator.return(undefined);
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

export function mockCompletionsFetch<T>(
	respond: (params: T, request: RequestInit, url: string) => Response | Promise<Response>,
): void {
	beforeEach(() => {
		vi.stubGlobal("fetch", async (url: string | URL | Request, request?: RequestInit) => {
			if (!request || typeof request.body !== "string") throw new Error("Expected a JSON completion request");
			return respond(JSON.parse(request.body) as T, request, String(url));
		});
	});
	afterEach(() => vi.unstubAllGlobals());
}
