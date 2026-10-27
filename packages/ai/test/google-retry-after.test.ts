import { describe, expect, it, vi } from "vitest";

const googleMock = vi.hoisted(() => ({ error: undefined as unknown }));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			// eslint-disable-next-line require-yield
			generateContentStream: async function* () {
				throw googleMock.error;
			},
		};
	}
	return {
		FinishReason: {},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: { THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED", LOW: "LOW", HIGH: "HIGH" },
	};
});

import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

/** Shaped like @google/genai's ApiError: `status`, no `headers`, the JSON error body as the message. */
function quotaError(retryDelay?: string): Error {
	const details = retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [];
	const body = { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED", details } };
	return Object.assign(new Error(JSON.stringify(body)), { status: 429 });
}

async function run() {
	return streamGoogle(getBuiltinModel("google", "gemini-2.5-flash"), context, { apiKey: "test-key" }).result();
}

describe("Google retry-after", () => {
	it("copies the RetryInfo delay of a 429 onto the error message", async () => {
		googleMock.error = quotaError("34s");
		const message = await run();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBe(34_000);
	});

	it("leaves retryAfterMs unset when the error has no RetryInfo", async () => {
		googleMock.error = quotaError();
		expect((await run()).retryAfterMs).toBeUndefined();
	});
});
