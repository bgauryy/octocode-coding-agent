import { afterEach, describe, expect, it, vi } from "vitest";
import type * as webGuard from "@octocodeai/octocode-common/web-guard";
import type { PublicFetchInit } from "@octocodeai/octocode-common/web-guard";
import { cachedSearch } from "../../src/octocode/web/search-cache.ts";

const network = vi.hoisted(() => ({ send: vi.fn<(url: string, init: PublicFetchInit) => Promise<Response>>() }));
vi.mock("@octocodeai/octocode-common/web-guard", async (original) => ({
	...(await original<typeof webGuard>()),
	publicFetch: (url: string, init: PublicFetchInit) => network.send(url, init),
}));
afterEach(() => network.send.mockReset());

const answer = () =>
	Response.json({
		results: [{ url: "https://example.com/a", title: "A", content: "text" }],
		organic: [{ link: "https://example.com/a", title: "A", snippet: "text" }],
	});
const env = { TAVILY_API_KEY: "fixture" };

describe("search result cache", () => {
	it("answers a repeated search within the lifetime without another request", async () => {
		network.send.mockImplementation(async () => answer());
		const search = cachedSearch();
		const first = await search("Node  streams", 5, env);
		const second = await search(" node streams ", 5, env);
		expect(second).toEqual(first);
		expect(network.send).toHaveBeenCalledTimes(1);
	});

	it("asks again after the lifetime", async () => {
		network.send.mockImplementation(async () => answer());
		let now = 0;
		const search = cachedSearch(undefined, () => now);
		await search("q", 5, env);
		now = 16 * 60_000;
		await search("q", 5, env);
		expect(network.send).toHaveBeenCalledTimes(2);
	});

	it("misses for another maxResults or another provider chain", async () => {
		network.send.mockImplementation(async () => answer());
		const search = cachedSearch();
		await search("q", 5, env);
		await search("q", 6, env);
		await search("q", 5, { SERPER_API_KEY: "fixture" });
		expect(network.send).toHaveBeenCalledTimes(3);
	});

	it("shares one request between simultaneous callers", async () => {
		network.send.mockImplementation(async () => answer());
		const search = cachedSearch();
		await Promise.all([search("q", 5, env), search("q", 5, env)]);
		expect(network.send).toHaveBeenCalledTimes(1);
	});

	it("never caches an error", async () => {
		let failing = true;
		network.send.mockImplementation(async () => (failing ? new Response("no", { status: 500 }) : answer()));
		const search = cachedSearch();
		await expect(search("q", 5, env)).rejects.toThrow("every provider failed");
		failing = false;
		expect((await search("q", 5, env)).hits).toHaveLength(1);
	});
});
