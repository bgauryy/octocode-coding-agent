import { describe, expect, it } from "vitest";
import {
	cancelBatch,
	createBatch,
	deleteFile,
	downloadFile,
	fetchBatchResults,
	getBatch,
	getFile,
	isBatchTerminal,
	listBatches,
	listFiles,
	parseBatchJsonl,
	uploadFile,
} from "../src/operations/index.ts";

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

const base = (f: typeof fetch) => ({ baseUrl: "https://api.example.com/v1", apiKey: KEY, fetch: f });
const fileObj = { id: "file-1", bytes: 3, created_at: 5, filename: "in.jsonl", purpose: "batch", status: "processed" };
const batchObj = (extra = {}) => ({
	id: "batch_1",
	status: "validating",
	endpoint: "/v1/embeddings",
	input_file_id: "file-1",
	created_at: 9,
	request_counts: { total: 2, completed: 0, failed: 0 },
	...extra,
});

describe("files", () => {
	it("uploads multipart, lists with query, gets, downloads and deletes", async () => {
		const { fn, calls } = mockFetch((c) => {
			if (c.method === "DELETE") return json({ id: "file-1", deleted: true });
			if (c.method === "POST") return json(fileObj);
			if (c.url.endsWith("/content")) return new Response(new Uint8Array([4, 5]));
			if (c.url.includes("/files?")) return json({ data: [fileObj], has_more: true });
			return json(fileObj);
		});
		const up = await uploadFile(base(fn), {
			file: { data: new Uint8Array([1, 2, 3]), filename: "in.jsonl" },
			purpose: "batch",
		});
		expect(up).toMatchObject({ id: "file-1", bytes: 3, purpose: "batch" });
		const form = calls[0]?.body as FormData;
		expect(form.get("purpose")).toBe("batch");
		expect((form.get("file") as File).size).toBe(3);
		const list = await listFiles(base(fn), { purpose: "batch", limit: 5 });
		expect(list).toMatchObject({ hasMore: true });
		expect(calls[1]?.url).toBe("https://api.example.com/v1/files?purpose=batch&limit=5");
		expect((await getFile(base(fn), "file-1")).filename).toBe("in.jsonl");
		expect([...(await downloadFile(base(fn), "file-1"))]).toEqual([4, 5]);
		expect(await deleteFile(base(fn), "file-1")).toEqual({ id: "file-1" });
	});

	it("fails on invalid input, malformed, http, size and cancellation", async () => {
		const { fn, calls } = mockFetch(() => json({ id: 1 }));
		await expect(
			uploadFile(base(fn), { file: { data: new Uint8Array(0), filename: "a" }, purpose: "batch" }),
		).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(
			uploadFile(base(fn), { file: { data: new Uint8Array(1), filename: "a" }, purpose: "" }),
		).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(getFile(base(fn), "a/b")).rejects.toMatchObject({ kind: "invalid_input" });
		expect(calls).toHaveLength(0);
		await expect(getFile(base(fn), "file-1")).rejects.toMatchObject({ kind: "malformed_response" });
		const nd = mockFetch(() => json({ id: "f", deleted: false }));
		await expect(deleteFile(base(nd.fn), "f")).rejects.toMatchObject({ kind: "malformed_response" });
		const e = mockFetch(() => json({ error: { message: "nf " + KEY } }, 404));
		const err = await getFile(base(e.fn), "f").catch((x) => x);
		expect(err).toMatchObject({ kind: "http", status: 404 });
		expect(err.message).not.toContain(KEY);
		const big = mockFetch(() => new Response(new Uint8Array(500)));
		await expect(downloadFile(base(big.fn), "f", { maxResponseBytes: 10 })).rejects.toMatchObject({
			kind: "response_too_large",
		});
		const h = mockFetch((_, s) => hang(s));
		const ac = new AbortController();
		const p = listFiles(base(h.fn), {}, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
	});
});

describe("batch", () => {
	it("creates, gets, lists and cancels", async () => {
		const { fn, calls } = mockFetch((c) => {
			if (c.url.endsWith("/cancel")) return json(batchObj({ status: "cancelling" }));
			if (c.method === "POST") return json(batchObj());
			if (c.url.includes("/batches?")) return json({ data: [batchObj()], has_more: false });
			return json(batchObj({ status: "completed", output_file_id: "file-out" }));
		});
		const b = await createBatch(base(fn), { inputFileId: "file-1", endpoint: "/v1/embeddings", metadata: { k: "v" } });
		expect(b).toMatchObject({ id: "batch_1", requestCounts: { total: 2 } });
		expect(JSON.parse(calls[0]?.body as string)).toEqual({
			input_file_id: "file-1",
			endpoint: "/v1/embeddings",
			completion_window: "24h",
			metadata: { k: "v" },
		});
		const got = await getBatch(base(fn), "batch_1");
		expect(isBatchTerminal(got)).toBe(true);
		expect(got.outputFileId).toBe("file-out");
		expect((await listBatches(base(fn), { limit: 1 })).batches).toHaveLength(1);
		expect((await cancelBatch(base(fn), "batch_1")).status).toBe("cancelling");
	});

	it("downloads and parses results end-to-end", async () => {
		const jsonl = [
			JSON.stringify({ custom_id: "a", response: { status_code: 200, body: { ok: 1 } }, error: null }),
			"",
			JSON.stringify({ custom_id: "b", response: null, error: { code: "x", message: "m" } }),
		].join("\n");
		const { fn, calls } = mockFetch(() => new Response(jsonl));
		const lines = await fetchBatchResults(base(fn), {
			id: "b",
			status: "completed",
			endpoint: "e",
			inputFileId: "i",
			outputFileId: "file-out",
			createdAt: 1,
		});
		expect(lines).toEqual([
			{ customId: "a", statusCode: 200, response: { ok: 1 }, error: undefined },
			{ customId: "b", statusCode: undefined, response: undefined, error: { code: "x", message: "m" } },
		]);
		expect(calls[0]?.url).toBe("https://api.example.com/v1/files/file-out/content");
		await expect(
			fetchBatchResults(base(fn), { id: "b", status: "in_progress", endpoint: "e", inputFileId: "i", createdAt: 1 }),
		).rejects.toMatchObject({ kind: "invalid_input" });
	});

	it("rejects malformed jsonl and responses; reports http errors", async () => {
		expect(() => parseBatchJsonl("{bad")).toThrow(/line 1/);
		expect(() => parseBatchJsonl('{"x":1}')).toThrow(/custom_id/);
		const { fn } = mockFetch(() => json({ id: "b" }));
		await expect(getBatch(base(fn), "b")).rejects.toMatchObject({ kind: "malformed_response" });
		await expect(createBatch(base(fn), { inputFileId: "", endpoint: "/v1/embeddings" })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		const e = mockFetch(() => json({ error: { message: "bad" } }, 400));
		await expect(createBatch(base(e.fn), { inputFileId: "f", endpoint: "/v1/embeddings" })).rejects.toMatchObject({
			kind: "http",
			status: 400,
		});
		const h = mockFetch((_, s) => hang(s));
		await expect(getBatch(base(h.fn), "b", { timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
	});
});
