import { afterEach, describe, expect, it, vi } from "vitest";
import type * as webGuard from "../../../common/src/web-guard.ts";
import type { PublicFetchInit } from "../../../common/src/web-guard.ts";
import { search } from "../../src/octocode/web/search.ts";
import { searchSite } from "../../src/octocode/web/search-site.ts";

const network = vi.hoisted(() => ({ send: vi.fn<(url: string, init: PublicFetchInit) => Promise<Response>>() }));
vi.mock("../../../common/src/web-guard.ts", async (original) => ({
	...(await original<typeof webGuard>()),
	publicFetch: (url: string, init: PublicFetchInit) => network.send(url, init),
}));
afterEach(() => network.send.mockReset());

describe("site-restricted search", () => {
	it("falls through unrelated provider answers and keeps later matching results", async () => {
		const requests: string[] = [];
		network.send.mockImplementation(async (url) => {
			requests.push(url);
			if (url.includes("html.duckduckgo.com")) return new Response("challenge", { status: 202 });
			if (url.includes("www.bing.com"))
				return new Response('<li class="b_algo"><h2><a href="https://unrelated.example/">Noise</a></h2></li>');
			return new Response(
				'<a class="result-link" href="https://other.example/">Noise</a>' +
					'<a class="result-link" href="https://docs.example.com/guide">Guide</a>',
			);
		});
		const result = await search("site:example.com guide", 1, {});
		expect(result.provider).toBe("duckduckgo-lite");
		expect(result.hits).toEqual([{ title: "Guide", url: "https://docs.example.com/guide", snippet: "" }]);
		expect(result.failures).toContain("bing: discarded results outside the site restriction");
		expect(requests).toHaveLength(3);
	});

	it("applies the same restriction to keyed providers without accepting suffix lookalikes", async () => {
		network.send.mockImplementation(async (url) =>
			url.includes("api.tavily.com")
				? Response.json({ results: [{ url: "https://example.com.evil.test/", title: "Wrong" }] })
				: Response.json({ organic: [{ link: "https://example.com/", title: "Right" }] }),
		);
		const result = await search("site:example.com", 3, { TAVILY_API_KEY: "fixture", SERPER_API_KEY: "fixture" });
		expect(result.provider).toBe("serper");
		expect(result.hits.map((hit) => hit.url)).toEqual(["https://example.com/"]);
	});

	it("reports no results when every answer violates the domain constraint", async () => {
		network.send.mockImplementation(async () => Response.json({ results: [{ url: "https://other.example/" }] }));
		const result = await search("site:example.com", 3, { TAVILY_API_KEY: "fixture" });
		expect(result.hits).toEqual([]);
		expect(result.failures).toContain("tavily: discarded results outside the site restriction");
	});

	it("respects URL prefixes, protocol, host boundaries and subdomains", () => {
		const domain = searchSite("guide site:EXAMPLE.com/docs");
		expect(domain?.("https://sub.example.com/docs/intro")).toBe(true);
		expect(domain?.("https://example.com/other")).toBe(false);
		expect(domain?.("https://notexample.com/docs")).toBe(false);
		const prefix = searchSite("site:https://example.com/docs?q=one");
		expect(prefix?.("https://example.com/docs?q=one-more")).toBe(true);
		expect(prefix?.("http://example.com/docs?q=one")).toBe(false);
		expect(prefix?.("https://sub.example.com/docs?q=one")).toBe(false);
	});

	it.each([
		'"site:example.com"',
		"site:example.com OR site:other.example",
		"site:example.com OR unrelated",
		"site:example.com | unrelated",
		"(site:example.com) OR unrelated",
		"site:example.com site:other.example",
		"-site:example.com",
		"site:",
		"site:https://user:password@example.com",
	])("leaves ambiguous, quoted or malformed query semantics to the provider: %s", (query) => {
		expect(searchSite(query)).toBeUndefined();
	});
});
