import { describe, expect, it } from "vitest";
import { createEmbeddings, OperationError } from "../src/operations/index.ts";

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

const base = (f: typeof fetch) => ({ baseUrl: "https://api.example.com/v1/", apiKey: KEY, fetch: f });

describe("createEmbeddings", () => {
	it("posts an OpenAI-compatible request and orders vectors by index", async () => {
		const { fn, calls } = mockFetch(() =>
			json({
				model: "m1",
				data: [
					{ index: 1, embedding: [3, 4] },
					{ index: 0, embedding: [1, 2] },
				],
				usage: { prompt_tokens: 5, total_tokens: 5 },
			}),
		);
		const r = await createEmbeddings(base(fn), { model: "m", input: ["a", "b"], dimensions: 2 });
		expect(r.embeddings).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(r.usage).toEqual({ promptTokens: 5, totalTokens: 5 });
		expect(calls[0]?.url).toBe("https://api.example.com/v1/embeddings");
		expect(calls[0]?.headers.Authorization).toBe("Bearer " + KEY);
		expect(JSON.parse(calls[0]?.body as string)).toMatchObject({
			model: "m",
			input: ["a", "b"],
			dimensions: 2,
			encoding_format: "float",
		});
	});

	it("decodes base64 float32 vectors", async () => {
		const buf = Buffer.alloc(8);
		buf.writeFloatLE(0.5, 0);
		buf.writeFloatLE(-2, 4);
		const { fn } = mockFetch(() => json({ data: [{ index: 0, embedding: buf.toString("base64") }] }));
		expect((await createEmbeddings(base(fn), { model: "m", input: "a" })).embeddings).toEqual([[0.5, -2]]);
	});

	it("rejects invalid input before any request", async () => {
		const { fn, calls } = mockFetch(() => json({}));
		await expect(createEmbeddings(base(fn), { model: "m", input: [] })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		await expect(createEmbeddings(base(fn), { model: "m", input: [""] })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		expect(calls).toHaveLength(0);
	});

	it("fails loudly on malformed responses", async () => {
		for (const body of [
			{ data: [] },
			{ data: [{ index: 0, embedding: [] }] },
			{ data: [{ index: 5, embedding: [1] }] },
			{ nope: 1 },
		]) {
			const { fn } = mockFetch(() => json(body));
			await expect(createEmbeddings(base(fn), { model: "m", input: "a" })).rejects.toMatchObject({
				kind: "malformed_response",
			});
		}
		const { fn } = mockFetch(() => new Response("<html>", { status: 200 }));
		await expect(createEmbeddings(base(fn), { model: "m", input: "a" })).rejects.toMatchObject({
			kind: "malformed_response",
		});
		const mixed = mockFetch(() =>
			json({
				data: [
					{ index: 0, embedding: [1] },
					{ index: 1, embedding: [1, 2] },
				],
			}),
		);
		await expect(createEmbeddings(base(mixed.fn), { model: "m", input: ["a", "b"] })).rejects.toMatchObject({
			kind: "malformed_response",
		});
	});

	it("surfaces HTTP errors with status and without configured credentials", async () => {
		const custom = "custom-header-secret";
		const { fn } = mockFetch(() => json({ error: { message: `bad keys ${KEY} ${custom}` } }, 401));
		const err = await createEmbeddings(
			{ ...base(fn), headers: { "X-Provider-Key": custom } },
			{ model: "m", input: "a" },
		).catch((e) => e);
		expect(err).toBeInstanceOf(OperationError);
		expect(err).toMatchObject({ kind: "http", status: 401 });
		expect(err.message).not.toContain(KEY);
		expect(err.message).not.toContain(custom);
	});

	it("redacts the key from network errors", async () => {
		const fn = (async () => {
			throw new Error("connect failed Bearer " + KEY);
		}) as unknown as typeof fetch;
		const err = await createEmbeddings(base(fn), { model: "m", input: "a" }).catch((e) => e);
		expect(err.kind).toBe("network");
		expect(err.message).not.toContain(KEY);
	});

	it("supports caller cancellation and timeout", async () => {
		const { fn } = mockFetch((_, s) => hang(s));
		const ac = new AbortController();
		const p = createEmbeddings(base(fn), { model: "m", input: "a" }, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
		await expect(createEmbeddings(base(fn), { model: "m", input: "a" }, { timeoutMs: 20 })).rejects.toMatchObject({
			kind: "timeout",
		});
		await expect(
			createEmbeddings(base(fn), { model: "m", input: "a" }, { signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ kind: "aborted" });
	});

	it("bounds response size from content-length and from streamed bytes", async () => {
		const big = mockFetch(() => new Response("{}", { status: 200, headers: { "content-length": "999999" } }));
		await expect(
			createEmbeddings(base(big.fn), { model: "m", input: "a" }, { maxResponseBytes: 100 }),
		).rejects.toMatchObject({ kind: "response_too_large" });
		const streamed = mockFetch(() => new Response("x".repeat(500), { status: 200 }));
		await expect(
			createEmbeddings(base(streamed.fn), { model: "m", input: "a" }, { maxResponseBytes: 100 }),
		).rejects.toMatchObject({ kind: "response_too_large" });
	});

	it("rejects non-http base URLs", async () => {
		await expect(createEmbeddings({ baseUrl: "file:///x" }, { model: "m", input: "a" })).rejects.toMatchObject({
			kind: "invalid_input",
		});
	});
});
