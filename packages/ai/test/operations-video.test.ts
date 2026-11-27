import { describe, expect, it } from "vitest";
import { createVideo, deleteVideo, downloadVideo, getVideoStatus, waitForVideo } from "../src/operations/index.ts";

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
const job = (status: string, extra = {}) => ({
	id: "video_1",
	status,
	model: "sora",
	progress: 10,
	created_at: 1,
	...extra,
});

describe("video", () => {
	it("creates, reads status, downloads and deletes", async () => {
		const { fn, calls } = mockFetch((c) => {
			if (c.method === "POST") return json(job("queued"));
			if (c.method === "DELETE") return json({ id: "video_1", deleted: true });
			if (c.url.includes("/content"))
				return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "video/mp4" } });
			return json(job("in_progress"));
		});
		const created = await createVideo(base(fn), { model: "sora", prompt: "a cat", seconds: "4", size: "1280x720" });
		expect(created).toMatchObject({ id: "video_1", status: "queued" });
		expect(JSON.parse(calls[0]?.body as string)).toEqual({
			model: "sora",
			prompt: "a cat",
			seconds: "4",
			size: "1280x720",
		});
		expect((await getVideoStatus(base(fn), "video_1")).status).toBe("in_progress");
		const dl = await downloadVideo(base(fn), "video_1", "thumbnail");
		expect([...dl.data]).toEqual([1, 2]);
		expect(dl.contentType).toBe("video/mp4");
		expect(calls[2]?.url).toBe("https://api.example.com/v1/videos/video_1/content?variant=thumbnail");
		expect(await deleteVideo(base(fn), "video_1")).toEqual({ id: "video_1" });
	});

	it("waits through statuses until completed with injected sleep", async () => {
		const seq = ["queued", "in_progress", "completed"];
		const { fn } = mockFetch(() => json(job(seq.shift() as string)));
		const sleeps: number[] = [];
		const seen: string[] = [];
		const done = await waitForVideo(base(fn), "video_1", {
			intervalMs: 7,
			sleep: async (ms) => void sleeps.push(ms),
			onStatus: (j) => seen.push(j.status),
		});
		expect(done.status).toBe("completed");
		expect(sleeps).toEqual([7, 7]);
		expect(seen).toEqual(["queued", "in_progress", "completed"]);
	});

	it("throws job_failed, timeout and aborts while sleeping", async () => {
		const f = mockFetch(() => json(job("failed", { error: { code: "moderation", message: "blocked" } })));
		await expect(waitForVideo(base(f.fn), "video_1")).rejects.toMatchObject({ kind: "job_failed" });
		const q = mockFetch(() => json(job("queued")));
		await expect(
			waitForVideo(base(q.fn), "video_1", { intervalMs: 10, maxWaitMs: 25, sleep: async () => {} }),
		).rejects.toMatchObject({ kind: "timeout" });
		const ac = new AbortController();
		const p = waitForVideo(base(q.fn), "video_1", { intervalMs: 60_000, signal: ac.signal });
		setTimeout(() => ac.abort(), 20);
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
	});

	it("validates ids, input, and malformed bodies", async () => {
		const { fn, calls } = mockFetch(() => json({ id: "v", status: "weird" }));
		await expect(getVideoStatus(base(fn), "../x")).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(createVideo(base(fn), { model: "m", prompt: "" })).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(createVideo(base(fn), { model: "m", prompt: "p", size: "big" })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		expect(calls).toHaveLength(0);
		await expect(getVideoStatus(base(fn), "v")).rejects.toMatchObject({ kind: "malformed_response" });
		const d = mockFetch(() => json({ id: "v", deleted: false }));
		await expect(deleteVideo(base(d.fn), "v")).rejects.toMatchObject({ kind: "malformed_response" });
		const empty = mockFetch(() => new Response("", { status: 200 }));
		await expect(downloadVideo(base(empty.fn), "v")).rejects.toMatchObject({ kind: "malformed_response" });
	});

	it("reports HTTP errors and bounds downloads", async () => {
		const e = mockFetch(() => json({ error: { message: "quota " + KEY } }, 429));
		const err = await createVideo(base(e.fn), { model: "m", prompt: "p" }).catch((x) => x);
		expect(err).toMatchObject({ kind: "http", status: 429 });
		expect(err.message).not.toContain(KEY);
		const big = mockFetch(() => new Response(new Uint8Array(500)));
		await expect(downloadVideo(base(big.fn), "v", "video", { maxResponseBytes: 100 })).rejects.toMatchObject({
			kind: "response_too_large",
		});
		const h = mockFetch((_, s) => hang(s));
		await expect(getVideoStatus(base(h.fn), "v", { timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
	});
});
