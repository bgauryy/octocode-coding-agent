import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

async function requestUrl(baseUrl: string) {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, index: 0, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const base = getBuiltinModel("google", "gemini-2.5-flash");
	const result = await streamSimple(
		{ ...base, baseUrl },
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "k", fetch },
	).result();
	expect(result.errorMessage).toBeUndefined();
	expect(fetch).toHaveBeenCalledOnce();
	return String(fetch.mock.calls[0][0]);
}

describe("Google Generative AI API version", () => {
	it.each([
		[
			"https://proxy.example/google?key=proxy-secret&alt=json",
			"https://proxy.example/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=proxy-secret",
		],
		[
			"https://proxy.example/v1beta?key=proxy-secret&trace=1&alt=json",
			"https://proxy.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=proxy-secret&trace=1",
		],
		[
			"https://generativelanguage.googleapis.com?key=proxy-secret",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=proxy-secret",
		],
	])("preserves base query parameters for %s without overriding SDK parameters", async (baseUrl, expected) => {
		expect(await requestUrl(baseUrl)).toBe(expected);
	});

	it.each([
		"https://proxy.example/google?key=proxy-secret",
		"https://proxy.example/v1beta?key=proxy-secret",
		"https://generativelanguage.googleapis.com?key=proxy-secret",
	])("does not log or expose query credentials on errors for %s", async (baseUrl) => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () => new Response('{"error":{"message":"invalid credentials"}}', { status: 401 }),
			);
			const base = getBuiltinModel("google", "gemini-2.5-flash");
			const result = await streamSimple(
				{ ...base, baseUrl },
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "test", fetch },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("invalid credentials");
			expect(result.errorMessage).not.toContain("proxy-secret");
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain("proxy-secret");
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			errorLog.mockRestore();
		}
	});
	it("pins v1beta when no base URL is configured", async () => {
		expect(await requestUrl("")).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
	});

	it("pins v1beta for a versionless custom base URL", async () => {
		expect(await requestUrl("https://proxy.example/google")).toBe(
			"https://proxy.example/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
	});

	it("leaves a v1 version path to a configured base URL", async () => {
		expect(await requestUrl("https://proxy.example/v1")).toBe(
			"https://proxy.example/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
	});

	it("leaves the version path to a configured base URL", async () => {
		expect(await requestUrl("https://proxy.example/v1beta")).toBe(
			"https://proxy.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
	});
});
