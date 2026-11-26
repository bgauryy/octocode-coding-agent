import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { fetchSdkResponse } from "../src/api/ai-sdk/transport.ts";
import { clearRejectedCapabilities } from "../src/utils/rejected-capabilities.ts";

const model = {
	id: "claude",
	name: "claude",
	api: "anthropic-messages",
	provider: "gw",
	baseUrl: "https://gw.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as Model<Api>;

const body = JSON.stringify({ system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] });

function endpoint() {
	const sent: string[] = [];
	const fetch = (async (_input: unknown, init?: RequestInit) => {
		const text = String(init?.body);
		sent.push(text);
		if (text.includes("cache_control"))
			return new Response(
				JSON.stringify({ error: { message: "system.0.cache_control: Extra inputs are not permitted" } }),
				{
					status: 400,
				},
			);
		return new Response("ok", { status: 200 });
	}) as typeof globalThis.fetch;
	return { sent, fetch };
}

describe("a gateway that rejects cache_control", () => {
	afterEach(() => clearRejectedCapabilities());

	it("costs one failed request, then the field is no longer sent", async () => {
		const { sent, fetch } = endpoint();
		const first = await fetchSdkResponse(model, { fetch, maxRetries: 0 }, "https://gw.example/v1/messages", {
			method: "POST",
			body,
		});
		expect(first.status).toBe(200);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toContain("cache_control");
		expect(sent[1]).not.toContain("cache_control");

		await fetchSdkResponse(model, { fetch, maxRetries: 0 }, "https://gw.example/v1/messages", {
			method: "POST",
			body,
		});
		expect(sent).toHaveLength(3);
		expect(sent[2]).not.toContain("cache_control");
	});

	it("does not resend after an unrelated 400", async () => {
		const sent: string[] = [];
		const fetch = (async (_input: unknown, init?: RequestInit) => {
			sent.push(String(init?.body));
			return new Response("bad max_tokens", { status: 400 });
		}) as typeof globalThis.fetch;
		await expect(
			fetchSdkResponse(model, { fetch, maxRetries: 0 }, "https://gw.example/v1/messages", {
				method: "POST",
				body,
			}),
		).rejects.toThrow();
		expect(sent).toHaveLength(1);
	});
});
