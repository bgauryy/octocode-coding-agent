import { describe, expect, it, vi } from "vitest";
import { completionsFetch } from "../src/api/ai-sdk/completions-fetch.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Strict OpenAI-compatible hosts (Amazon Bedrock Mantle) refuse a body without
// `Content-Type: application/json` with HTTP 400, so the request keeps the
// headers the SDK set while adding the client's own (authorization, user agent).
describe("openai-completions request headers", () => {
	it("keeps the SDK's content type and adds the client's authorization", async () => {
		const { compat: _compat, ...base } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...base, api: "openai-completions" } as const;
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
		const send = completionsFetch(model, normalizeContext({ messages: [] }), { fetch }, "test-key");

		await send("https://ignored.example/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer sdk-placeholder" },
			body: "{}",
		});

		const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("authorization")).toBe("Bearer test-key");
	});
});
