import { describe, expect, it } from "vitest";
import { oauthFetch } from "../../src/client/oauth/sdk.ts";

describe("OAuth fetch body cancellation", () => {
	it.each(["json", "text"] as const)(
		"aborts a stalled %s body after headers even when fetch ignores the signal",
		async (method) => {
			const controller = new AbortController();
			let cancelled: unknown;
			const response = await oauthFetch(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(stream) {
								stream.enqueue(new TextEncoder().encode('{"error":'));
							},
							cancel(reason) {
								cancelled = reason;
							},
						}),
						{ status: method === "json" ? 200 : 400 },
					),
				controller.signal,
			)("https://auth.example/token");
			// Headers have already arrived; cancellation must cover the SDK's subsequent body read.
			expect(response.status).toBe(method === "json" ? 200 : 400);
			const pending = expect(response[method]()).rejects.toMatchObject({ name: "AbortError" });
			controller.abort();
			await pending;
			expect(cancelled).toBe(controller.signal.reason);
		},
	);

	it("preserves redirect metadata and normalizes cloned JSON without mutating the fetch response", async () => {
		const original = Response.json({ access_token: "token", token_type: "Bearer", scope: "", expires_in: null });
		Object.defineProperties(original, {
			url: { value: "https://auth.example/token" },
			redirected: { value: true },
			type: { value: "cors" },
		});
		const originalJson = original.json;
		const controller = new AbortController();
		const response = await oauthFetch(async () => original, controller.signal)("https://auth.example/start");
		const clone = response.clone();
		for (const copy of [response, clone]) {
			expect(copy.url).toBe(original.url);
			expect(copy.redirected).toBe(true);
			expect(copy.type).toBe("cors");
			expect(await copy.json()).toEqual({ access_token: "token", token_type: "Bearer" });
		}
		expect(original.json).toBe(originalJson);
	});

	it("cancels both the original and cloned pending body on abort", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const response = await oauthFetch(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
			controller.signal,
		)("https://auth.example/token");
		const clone = response.clone();
		const originalRead = expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
		const clonedRead = expect(clone.json()).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await Promise.all([originalRead, clonedRead]);
		expect(cancelled).toBe(true);
	});
});
