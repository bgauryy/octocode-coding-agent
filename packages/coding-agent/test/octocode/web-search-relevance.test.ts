import { afterEach, describe, expect, it, vi } from "vitest";
import type * as webGuard from "../../../common/src/web-guard.ts";
import type { PublicFetchInit } from "../../../common/src/web-guard.ts";
import { search } from "../../src/octocode/web/search.ts";
import { queryTerms, relatedHit } from "../../src/octocode/web/search-relevance.ts";

const network = vi.hoisted(() => ({ send: vi.fn<(url: string, init: PublicFetchInit) => Promise<Response>>() }));
vi.mock("../../../common/src/web-guard.ts", async (original) => ({
	...(await original<typeof webGuard>()),
	publicFetch: (url: string, init: PublicFetchInit) => network.send(url, init),
}));
afterEach(() => network.send.mockReset());

const bing = (...hits: Array<[url: string, title: string, snippet?: string]>) =>
	new Response(
		hits
			.map(
				([url, title, snippet = ""]) =>
					`<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>${snippet}</p></li>`,
			)
			.join(""),
	);
const lite = (url: string, title: string) => new Response(`<a class="result-link" href="${url}">${title}</a>`);

describe("keyless search relevance", () => {
	it("skips a keyless provider whose results share no word with the query, and says so", async () => {
		network.send.mockImplementation(async (url) => {
			if (url.includes("html.duckduckgo.com")) return new Response("challenge", { status: 202 });
			if (url.includes("www.bing.com"))
				return bing(["https://www.zhihu.com/", "知乎 - 有问题，就会有答案"], ["https://www.baidu.com/", "百度一下"]);
			return lite("https://zod.dev/", "Zod: TypeScript-first schema validation");
		});
		const result = await search("zod schema validation npm", 5, {});
		expect(result.provider).toBe("duckduckgo-lite");
		expect(result.hits.map((hit) => hit.url)).toEqual(["https://zod.dev/"]);
		expect(result.failures).toContain("bing: results unrelated to the query");
	});

	it("keeps the related results of a keyless provider, matched in title, snippet or URL and by word stem", async () => {
		network.send.mockImplementation(async (url) =>
			url.includes("html.duckduckgo.com")
				? new Response("challenge", { status: 202 })
				: bing(
						["https://en.wikipedia.org/wiki/Main_Page", "Wikipedia, the free encyclopedia"],
						["https://nodejs.org/api/fetch.html", "Fetch API", "How Node follows a redirect"],
						["https://example.com/node-redirects", "Notes"],
					),
		);
		const result = await search("node.js fetch redirects", 5, {});
		expect(result.provider).toBe("bing");
		expect(result.hits.map((hit) => hit.url)).toEqual([
			"https://nodejs.org/api/fetch.html",
			"https://example.com/node-redirects",
		]);
	});

	it("does not count common words as overlap", async () => {
		network.send.mockImplementation(async (url) =>
			url.includes("html.duckduckgo.com")
				? new Response("challenge", { status: 202 })
				: url.includes("www.bing.com")
					? bing(["https://news.example/", "What the world is reading"])
					: new Response(""),
		);
		const result = await search("what is the zod library", 5, {});
		expect(result.hits).toEqual([]);
		expect(result.failures).toContain("bing: results unrelated to the query");
	});

	it("trusts keyed providers and queries without a significant word", async () => {
		network.send.mockImplementation(async (url) =>
			url.includes("api.tavily.com")
				? Response.json({ results: [{ url: "https://example.org/", title: "Unrelated words" }] })
				: bing(["https://example.net/", "Anything"]),
		);
		expect((await search("zod schema", 3, { TAVILY_API_KEY: "fixture" })).provider).toBe("tavily");
		const short = await search("js", 3, {});
		expect(short.provider).toBe("bing");
		expect(short.hits).toHaveLength(1);
	});
});

describe("query terms", () => {
	const hit = (title: string) => ({ title, url: "https://example.com/x", snippet: "" });

	it("keeps a query of only common words as one phrase term", () => {
		const terms = queryTerms("What is THE");
		expect(terms).toEqual(["what is the"]);
		expect(relatedHit(terms, hit("Unrelated portal front page"))).toBe(false);
		expect(relatedHit(terms, hit("What is the answer"))).toBe(true);
	});

	it("leaves operator-only and short-word queries without terms and stems significant words", () => {
		expect(queryTerms("site:foo.com")).toEqual([]);
		expect(queryTerms("js")).toEqual([]);
		expect(queryTerms("typescript what is")).toEqual(["typescri"]);
	});
});
