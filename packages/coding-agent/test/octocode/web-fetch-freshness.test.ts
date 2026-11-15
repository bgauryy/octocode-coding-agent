import { afterEach, describe, expect, it, vi } from "vitest";
import type * as webGuard from "../../../common/src/web-guard.ts";
import type { PublicFetchInit } from "../../../common/src/web-guard.ts";
import { pageFetcher } from "../../src/octocode/web/fetch.ts";
import { freshnessOf, pageCache } from "../../src/octocode/web/page-cache.ts";

const network = vi.hoisted(() => ({ send: vi.fn<(url: string, init: PublicFetchInit) => Promise<Response>>() }));
vi.mock("../../../common/src/web-guard.ts", async (original) => ({
	...(await original<typeof webGuard>()),
	publicFetch: (url: string, init: PublicFetchInit) => network.send(url, init),
}));
afterEach(() => {
	network.send.mockReset();
	vi.useRealTimers();
});

const page = (text: string, headers: Record<string, string> = {}) =>
	new Response(text, { headers: { "content-type": "text/plain", ...headers } });

describe("page cache freshness", () => {
	it("reuses a page within its lifetime", async () => {
		network.send.mockImplementation(async () => page("one"));
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		expect(await fetchUrl("https://a.test/", undefined)).toBe("one");
		expect(network.send).toHaveBeenCalledTimes(1);
	});

	it("does not cache no-store", async () => {
		network.send.mockImplementation(async () => page("one", { "cache-control": "private, no-store" }));
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		await fetchUrl("https://a.test/", undefined);
		expect(network.send).toHaveBeenCalledTimes(2);
	});

	it("honors a short max-age", async () => {
		vi.useFakeTimers();
		network.send.mockImplementation(async () => page("one", { "cache-control": "max-age=60" }));
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		vi.advanceTimersByTime(30_000);
		await fetchUrl("https://a.test/", undefined);
		expect(network.send).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(31_000);
		await fetchUrl("https://a.test/", undefined);
		expect(network.send).toHaveBeenCalledTimes(2);
	});

	it("revalidates an expired page and reuses its text on 304", async () => {
		vi.useFakeTimers();
		network.send.mockImplementationOnce(async () =>
			page("one", { "cache-control": "max-age=1", etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" }),
		);
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		vi.advanceTimersByTime(2_000);
		network.send.mockImplementationOnce(async () => new Response(null, { status: 304 }));
		expect(await fetchUrl("https://a.test/", undefined)).toBe("one");
		const headers = network.send.mock.calls[1][1].headers as Record<string, string>;
		expect(headers["if-none-match"]).toBe('"v1"');
		expect(headers["if-modified-since"]).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
		// The 304 made it fresh again.
		await fetchUrl("https://a.test/", undefined);
		expect(network.send).toHaveBeenCalledTimes(2);
	});

	it("replaces the text when the server answers 200 to the revalidation", async () => {
		vi.useFakeTimers();
		network.send.mockImplementationOnce(async () => page("one", { "cache-control": "max-age=1", etag: '"v1"' }));
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		vi.advanceTimersByTime(2_000);
		network.send.mockImplementationOnce(async () => page("two", { etag: '"v2"' }));
		expect(await fetchUrl("https://a.test/", undefined)).toBe("two");
	});

	it("refetches an expired page that has no validators", async () => {
		vi.useFakeTimers();
		network.send.mockImplementation(async () => page("one", { "cache-control": "max-age=1" }));
		const fetchUrl = pageFetcher();
		await fetchUrl("https://a.test/", undefined);
		vi.advanceTimersByTime(2_000);
		await fetchUrl("https://a.test/", undefined);
		expect(network.send).toHaveBeenCalledTimes(2);
		expect(network.send.mock.calls[1][1].headers).not.toHaveProperty("if-none-match");
	});
});

describe("freshnessOf", () => {
	it("caps max-age at 15 minutes and reads validators", () => {
		const fresh = freshnessOf(new Headers({ "cache-control": "public, max-age=86400", etag: "W/x" }));
		expect(fresh).toMatchObject({ noStore: false, ttlMs: 15 * 60_000, etag: "W/x" });
		expect(freshnessOf(new Headers({ "cache-control": "max-age=30" })).ttlMs).toBe(30_000);
		expect(freshnessOf(new Headers()).ttlMs).toBe(15 * 60_000);
	});

	it("evicts the least recently used page beyond the bound", () => {
		const cache = pageCache();
		for (let i = 0; i < 65; i++) cache.set(`u${i}`, "x", { noStore: false, ttlMs: 1000 });
		expect(cache.get("u0")).toBeUndefined();
		expect(cache.get("u64")?.fresh).toBe(true);
	});
});
