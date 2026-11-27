import { describe, expect, it, vi } from "vitest";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { googleContext } from "./google-fetch-fixture.ts";

describe.each(["google", "google-vertex"] as const)("%s RetryInfo", (provider) => {
	it.each(["9s", undefined])("respects the body delay %s before sending a second request", async (retryDelay) => {
		const details = retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [];
		const fetch = vi.fn(async () =>
			Response.json({ error: { code: 429, message: "Resource exhausted", details } }, { status: 429 }),
		);
		const options = {
			apiKey: "fixture",
			env: { GOOGLE_VERTEX_API_KEY: "fixture" },
			fetch,
			maxRetries: retryDelay ? 1 : 0,
			maxRetryDelayMs: 100,
		};
		const result = await (
			provider === "google"
				? google(getBuiltinModel("google", "gemini-2.5-flash"), googleContext, options)
				: vertex(getBuiltinModel("google-vertex", "gemini-3-flash-preview"), googleContext, options)
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(retryDelay ? 9000 : undefined);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
