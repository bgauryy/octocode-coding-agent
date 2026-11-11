import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { ProviderResponse } from "../src/types.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const chunk = {
	candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

/** Stubs global fetch (the SDK's transport) with an SSE body; `open` keeps it open until the request aborts. */
function stubFetch(open: boolean): { aborted: () => boolean } {
	let aborted = false;
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		init?.signal?.addEventListener("abort", () => {
			aborted = true;
		});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
				if (!open) controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "r1" } });
	});
	return { aborted: () => aborted };
}

const adapters = [
	{
		name: "Google Generative AI",
		run: (options: Parameters<typeof streamGoogle>[2]) =>
			streamGoogle(getBuiltinModel("google", "gemini-2.5-flash"), context, { apiKey: "test-key", ...options }),
	},
	{
		name: "Google Vertex",
		run: (options: Parameters<typeof streamVertex>[2]) =>
			streamVertex(getBuiltinModel("google-vertex", "gemini-2.5-flash"), context, { apiKey: "test-key", ...options }),
	},
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(adapters)("$name onResponse", ({ run }) => {
	it("reports the response status and headers once before the stream is read", async () => {
		stubFetch(false);
		const seen: ProviderResponse[] = [];
		const message = await run({
			onResponse: (response) => {
				seen.push(response);
			},
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0].status).toBe(200);
		expect(seen[0].headers["x-request-id"]).toBe("r1");
	});

	it("aborts the request when the response hook fails", async () => {
		const fetch = stubFetch(true);
		const message = await run({
			onResponse: () => {
				throw new Error("hook failure");
			},
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("hook failure");
		expect(fetch.aborted()).toBe(true);
	});
});
