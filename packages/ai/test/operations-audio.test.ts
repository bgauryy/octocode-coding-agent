import { describe, expect, it } from "vitest";
import {
	appendAudio,
	collectResponse,
	MAX_TRANSCRIPTION_BYTES,
	openRealtimeSession,
	synthesizeSpeech,
	transcribeAudio,
	type RealtimeHandlers,
	type RealtimeTransport,
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
const file = { data: new Uint8Array([1, 2, 3]), filename: "a.wav", contentType: "audio/wav" };

describe("transcribeAudio", () => {
	it("sends multipart and parses json", async () => {
		const { fn, calls } = mockFetch(() => json({ text: "hello", language: "en" }));
		const r = await transcribeAudio(base(fn), { model: "w", file, language: "en", temperature: 0.2 });
		expect(r).toMatchObject({ text: "hello", format: "json", details: { language: "en" } });
		const form = calls[0]?.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get("model")).toBe("w");
		expect((form.get("file") as File).name).toBe("a.wav");
		expect(form.get("language")).toBe("en");
		expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
	});

	it("returns plain text for srt", async () => {
		const { fn } = mockFetch(() => new Response("1\n00:00", { status: 200 }));
		expect(await transcribeAudio(base(fn), { model: "w", file, responseFormat: "srt" })).toEqual({
			text: "1\n00:00",
			format: "srt",
		});
	});

	it("validates input and fails on malformed or error responses", async () => {
		const { fn, calls } = mockFetch(() => json({ nope: 1 }));
		await expect(
			transcribeAudio(base(fn), { model: "w", file: { ...file, data: new Uint8Array(0) } }),
		).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(
			transcribeAudio(base(fn), {
				model: "w",
				file: { ...file, data: new Blob([new Uint8Array(1)]), filename: 'a"b' },
			}),
		).rejects.toMatchObject({ kind: "invalid_input" });
		await expect(transcribeAudio(base(fn), { model: "w", file, temperature: 5 })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		expect(MAX_TRANSCRIPTION_BYTES).toBe(25 * 1024 * 1024);
		expect(calls).toHaveLength(0);
		await expect(transcribeAudio(base(fn), { model: "w", file })).rejects.toMatchObject({ kind: "malformed_response" });
		const e = mockFetch(() => json({ error: { message: "nope" } }, 400));
		await expect(transcribeAudio(base(e.fn), { model: "w", file })).rejects.toMatchObject({
			kind: "http",
			status: 400,
		});
	});

	it("cancels", async () => {
		const { fn } = mockFetch((_, s) => hang(s));
		await expect(transcribeAudio(base(fn), { model: "w", file }, { timeoutMs: 15 })).rejects.toMatchObject({
			kind: "timeout",
		});
	});
});

describe("synthesizeSpeech", () => {
	it("returns audio bytes and content type", async () => {
		const { fn, calls } = mockFetch(
			() => new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
		);
		const r = await synthesizeSpeech(base(fn), { model: "t", input: "hi", voice: "alloy", speed: 1.5 });
		expect([...r.audio]).toEqual([9, 8, 7]);
		expect(r).toMatchObject({ contentType: "audio/mpeg", format: "mp3" });
		expect(JSON.parse(calls[0]?.body as string)).toMatchObject({
			model: "t",
			voice: "alloy",
			response_format: "mp3",
			speed: 1.5,
		});
	});

	it("rejects bad input, empty, non-audio and oversized responses", async () => {
		const { fn } = mockFetch(() => new Response("", { status: 200 }));
		await expect(synthesizeSpeech(base(fn), { model: "t", input: "x".repeat(4097), voice: "v" })).rejects.toMatchObject(
			{ kind: "invalid_input" },
		);
		await expect(synthesizeSpeech(base(fn), { model: "t", input: "x", voice: "v", speed: 9 })).rejects.toMatchObject({
			kind: "invalid_input",
		});
		await expect(synthesizeSpeech(base(fn), { model: "t", input: "x", voice: "v" })).rejects.toMatchObject({
			kind: "malformed_response",
		});
		const j = mockFetch(() => json({ error: 1 }));
		await expect(synthesizeSpeech(base(j.fn), { model: "t", input: "x", voice: "v" })).rejects.toMatchObject({
			kind: "malformed_response",
		});
		const big = mockFetch(
			() => new Response(new Uint8Array(300), { status: 200, headers: { "content-type": "audio/wav" } }),
		);
		await expect(
			synthesizeSpeech(base(big.fn), { model: "t", input: "x", voice: "v" }, { maxResponseBytes: 100 }),
		).rejects.toMatchObject({ kind: "response_too_large" });
	});

	it("cancels", async () => {
		const { fn } = mockFetch((_, s) => hang(s));
		const ac = new AbortController();
		const p = synthesizeSpeech(base(fn), { model: "t", input: "x", voice: "v" }, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
	});
});

class FakeTransport implements RealtimeTransport {
	handlers?: RealtimeHandlers;
	sent: string[] = [];
	closed: Array<[number | undefined, string | undefined]> = [];
	url = "";
	headers: Record<string, string> = {};
	hangConnect = false;
	async connect(req: Parameters<RealtimeTransport["connect"]>[0]) {
		this.url = req.url;
		this.headers = req.headers;
		this.handlers = req.handlers;
		if (this.hangConnect)
			await new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new Error("connect aborted"))));
		return {
			send: (d: string) => void this.sent.push(d),
			close: (c?: number, r?: string) => void this.closed.push([c, r]),
		};
	}
	emit(event: unknown) {
		this.handlers?.onMessage(typeof event === "string" ? event : JSON.stringify(event));
	}
}

describe("realtime", () => {
	const open = (t: FakeTransport, extra = {}) =>
		openRealtimeSession(
			{ baseUrl: "https://api.example.com/v1", apiKey: KEY, transport: t, ...extra },
			{ model: "rt" },
		);

	it("connects with auth headers, sends audio and collects a response", async () => {
		const t = new FakeTransport();
		const s = await open(t);
		expect(t.url).toBe("wss://api.example.com/v1/realtime?model=rt");
		expect(t.headers.Authorization).toBe("Bearer " + KEY);
		appendAudio(s, new Uint8Array([1, 2, 3, 4, 5]), 2);
		expect(t.sent.map((x) => JSON.parse(x).type)).toEqual(Array(3).fill("input_audio_buffer.append"));
		s.send({ type: "input_audio_buffer.commit" });
		s.send({ type: "response.create" });
		const p = collectResponse(s, { timeoutMs: 1000 });
		t.emit({ type: "response.audio.delta", delta: "AA==" });
		t.emit({ type: "response.done" });
		expect((await p).map((e) => e.type)).toEqual(["response.audio.delta", "response.done"]);
		s.close();
		expect(t.closed).toEqual([[1000, "client closed"]]);
		expect(() => s.send({ type: "x" })).toThrow();
	});

	it("fails on server error events, malformed events and abnormal close", async () => {
		const custom = "custom-realtime-secret";
		const t = new FakeTransport();
		const s = await open(t, { headers: { "X-Provider-Key": custom } });
		t.emit({ type: "error", error: { message: `bad ${custom}` } });
		const serverError = await collectResponse(s).catch((error) => error);
		expect(serverError).toMatchObject({ kind: "transport" });
		expect(serverError.message).not.toContain(custom);
		const t2 = new FakeTransport();
		const s2 = await open(t2);
		t2.emit("not json");
		await expect(s2.next()).rejects.toMatchObject({ kind: "malformed_response" });
		expect(t2.closed).toHaveLength(1);
		const t3 = new FakeTransport();
		const s3 = await open(t3);
		t3.handlers?.onClose(1006, "gone " + KEY);
		const err = await s3.next().catch((e) => e);
		expect(err.kind).toBe("transport");
		expect(err.message).not.toContain(KEY);
		const t4 = new FakeTransport();
		const s4 = await open(t4);
		t4.handlers?.onClose(1000, "");
		expect(await s4.next()).toBeUndefined();
	});

	it("ignores a parent abort after the server closed cleanly", async () => {
		const t = new FakeTransport();
		const ac = new AbortController();
		const s = await openRealtimeSession({ baseUrl: "https://a", transport: t }, { model: "rt" }, { signal: ac.signal });
		t.handlers?.onClose(1000, "");
		ac.abort();
		expect(await s.next()).toBeUndefined();
		expect(t.closed).toHaveLength(0);
	});

	it("bounds queued events", async () => {
		const t = new FakeTransport();
		const s = await open(t, { maxQueuedEvents: 2 });
		for (let i = 0; i < 3; i++) t.emit({ type: "e" });
		await expect(s.next()).rejects.toMatchObject({ kind: "transport" });
	});

	it("times out next, aborts waiting readers, and aborts connect", async () => {
		const t = new FakeTransport();
		const ac = new AbortController();
		const s = await openRealtimeSession({ baseUrl: "https://a", transport: t }, { model: "rt" }, { signal: ac.signal });
		await expect(s.next({ timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
		const waiting = s.next();
		ac.abort();
		await expect(waiting).rejects.toMatchObject({ kind: "aborted" });
		expect(t.closed).toHaveLength(1);
		const h = new FakeTransport();
		h.hangConnect = true;
		await expect(
			openRealtimeSession({ baseUrl: "https://a", transport: h }, { model: "rt" }, { connectTimeoutMs: 10 }),
		).rejects.toMatchObject({ kind: "timeout" });
		await expect(openRealtimeSession({ baseUrl: "ftp://a", transport: h }, { model: "rt" })).rejects.toMatchObject({
			kind: "invalid_input",
		});
	});
});
