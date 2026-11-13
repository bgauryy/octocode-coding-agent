import { expect, it, vi } from "vitest";
import { labelTokens, type RequestContext } from "../src/api/llama-cpp-classify/server.ts";

it("bounds completed label lookups while retaining recent model entries", async () => {
	const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const { content } = JSON.parse(String(init?.body)) as { content: string };
		return Response.json({ tokens: content === "\n" ? [1] : [1, 2] });
	});
	const request = (id: string): RequestContext => ({
		root: "http://label-cache.test",
		model: {
			type: "classifier",
			id,
			name: id,
			api: "llama-cpp-classify",
			provider: "test",
			baseUrl: "http://label-cache.test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
		},
		options: { fetch },
	});
	await labelTokens(request("first"), ["A"]);
	for (let index = 0; index < 1024; index++) await labelTokens(request(`model-${index}`), ["A"]);
	const requests = fetch.mock.calls.length;
	await labelTokens(request("model-1023"), ["A"]);
	expect(fetch).toHaveBeenCalledTimes(requests);
	await labelTokens(request("first"), ["A"]);
	expect(fetch).toHaveBeenCalledTimes(requests + 2);
});
