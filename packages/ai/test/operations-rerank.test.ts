import { describe, expect, it } from "vitest";
import { rerank, type RerankConfig } from "../src/operations/index.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function mockFetch(handler: (call: Call, signal: AbortSignal) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		const call: Call = {
			url,
			method: init.method ?? "GET",
			headers: init.headers as Record<string, string>,
			body: init.body,
		};
		calls.push(call);
		return handler(call, init.signal as AbortSignal);
	}) as unknown as typeof fetch;
	return { fn, calls };
}
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const hang = (signal: AbortSignal) =>
	new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted by signal"))));
const KEY = "sk-secretkey123456";

const cfg = (f: typeof fetch, shape: RerankConfig["shape"], endpoint = "v2/rerank"): RerankConfig => ({
	baseUrl: "https://r.example.com",
	apiKey: KEY,
	fetch: f,
	shape,
	endpoint,
});
const docs = ["alpha", "beta", "gamma"];

describe("rerank", () => {
	it("cohere shape: explicit endpoint, top_n, sorted hits mapped to documents", async () => {
		const { fn, calls } = mockFetch(() =>
			json({
				results: [
					{ index: 0, relevance_score: 0.1 },
					{ index: 2, relevance_score: 0.9 },
					{ index: 1, relevance_score: 0.5 },
				],
			}),
		);
		const hits = await rerank(cfg(fn, "cohere"), { model: "rr", query: "q", documents: docs, topN: 2 });
		expect(hits).toEqual([
			{ index: 2, score: 0.9, document: "gamma" },
			{ index: 1, score: 0.5, document: "beta" },
		]);
		expect(calls[0]?.url).toBe("https://r.example.com/v2/rerank");
		expect(JSON.parse(calls[0]?.body as string)).toEqual({ model: "rr", query: "q", documents: docs, top_n: 2 });
	});

	it("voyage shape uses top_k and data", async () => {
		const { fn, calls } = mockFetch(() => json({ data: [{ index: 1, relevance_score: 2 }] }));
		const hits = await rerank(cfg(fn, "voyage", "rerank"), { model: "rr", query: "q", documents: docs, topN: 1 });
		expect(hits[0]?.document).toBe("beta");
		expect(JSON.parse(calls[0]?.body as string).top_k).toBe(1);
	});

	it("tei shape sends texts, no model, and reads a bare array", async () => {
		const { fn, calls } = mockFetch(() =>
			json([
				{ index: 1, score: 0.7 },
				{ index: 0, score: 0.2 },
			]),
		);
		const hits = await rerank(cfg(fn, "tei", "rerank"), { query: "q", documents: docs });
		expect(hits.map((h) => h.index)).toEqual([1, 0]);
		expect(JSON.parse(calls[0]?.body as string)).toEqual({ query: "q", texts: docs });
	});

	it("validates input and responses", async () => {
		const ok = mockFetch(() => json({ results: [] }));
		await expect(rerank(cfg(ok.fn, "cohere"), { query: "q", documents: docs })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		await expect(rerank(cfg(ok.fn, "cohere", ""), { model: "m", query: "q", documents: docs })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		await expect(rerank(cfg(ok.fn, "cohere"), { model: "m", query: "q", documents: [] })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		expect(ok.calls).toHaveLength(0);
		for (const body of [
			{ results: [{ index: 9, relevance_score: 1 }] },
			{ results: [{ index: 0, relevance_score: "x" }] },
			{ data: [] },
			{
				results: [
					{ index: 0, relevance_score: 1 },
					{ index: 0, relevance_score: 1 },
				],
			},
		]) {
			const { fn } = mockFetch(() => json(body));
			await expect(rerank(cfg(fn, "cohere"), { model: "m", query: "q", documents: docs })).rejects.toMatchObject({
				kind: "malformed_response",
			});
		}
	});

	it("reports http errors and cancellation", async () => {
		const e = mockFetch(() => new Response("boom " + KEY, { status: 503 }));
		const err = await rerank(cfg(e.fn, "cohere"), { model: "m", query: "q", documents: docs }).catch((x) => x);
		expect(err).toMatchObject({ kind: "http", status: 503 });
		expect(err.message).not.toContain(KEY);
		const h = mockFetch((_, s) => hang(s));
		const ac = new AbortController();
		const p = rerank(cfg(h.fn, "cohere"), { model: "m", query: "q", documents: docs }, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
	});
});
