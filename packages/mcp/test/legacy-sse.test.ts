import { describe, expect, it, vi } from "vitest";
import { LegacySseTransport, McpAbortError, McpClient, LATEST_PROTOCOL_VERSION, type McpFetch } from "../src/index.ts";

const encoder = new TextEncoder();
const base = "https://example.test/events";

function stream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		body,
		write(value: string) {
			controller.enqueue(encoder.encode(value));
		},
		end() {
			controller.close();
		},
		cancelled() {
			return cancelled;
		},
	};
}

const sse = (body: ReadableStream<Uint8Array>) =>
	new Response(body, { headers: { "content-type": "text/event-stream" } });
const event = (type: string, data: string) => `event: ${type}\ndata: ${data}\n\n`;

describe("legacy HTTP+SSE transport", () => {
	it("connects McpClient, lists tools, and rejects a pending request when SSE ends", async () => {
		const incoming = stream();
		const sent: string[] = [];
		const fetch: McpFetch = async (_url, init) => {
			if (init?.method === "GET") {
				queueMicrotask(() => incoming.write(event("endpoint", "/post")));
				return sse(incoming.body);
			}
			const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
			sent.push(message.method);
			if (message.id !== undefined && message.method !== "ping") {
				const result =
					message.method === "initialize"
						? {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: "mock-sse", version: "1" },
							}
						: { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
				queueMicrotask(() =>
					incoming.write(event("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))),
				);
			}
			return new Response(null, { status: 202 });
		};
		const client = new McpClient({ name: "sse-test", version: "1" });
		await client.connect(new LegacySseTransport({ url: base, fetch }));
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
		const pending = client.ping();
		await vi.waitFor(() => expect(sent).toContain("ping"));
		incoming.end();
		await expect(pending).rejects.toThrow(/closed|stream ended/i);
		expect(client.connectionState).toBe("closed");
	});

	it("waits for endpoint, posts JSON-RPC to the same origin, and reads message events", async () => {
		const incoming = stream();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: McpFetch = async (url, init) => {
			requests.push({ url: String(url), init });
			return init?.method === "GET" ? sse(incoming.body) : new Response(null, { status: 202 });
		};
		const transport = new LegacySseTransport({ url: base, fetch });
		const messages: unknown[] = [];
		transport.onMessage((message) => messages.push(message));
		const starting = transport.start();
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		incoming.write(event("endpoint", "/post?session=abc"));
		await starting;
		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(requests[1]?.url).toBe("https://example.test/post?session=abc");
		expect(requests[1]?.init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
		expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ id: 1, method: "tools/list" });
		incoming.write(event("message", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })));
		await vi.waitFor(() => expect(messages).toHaveLength(1));
		await transport.close();
		await vi.waitFor(() => expect(incoming.cancelled()).toBe(true));
	});

	it.each([
		"https://evil.test/post",
		"//evil.test/post",
		"https://user:secret@example.test/post",
		"javascript:alert(1)",
	])("rejects unsafe endpoint %s before POST", async (endpoint) => {
		const incoming = stream();
		const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => sse(incoming.body));
		const transport = new LegacySseTransport({ url: base, fetch });
		const starting = transport.start();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		incoming.write(event("endpoint", endpoint));
		await expect(starting).rejects.toThrow("same-origin");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("settles a pending start on close, EOF, or endpoint deadline", async () => {
		const pending = stream();
		const closed = new LegacySseTransport({ url: base, fetch: async () => sse(pending.body) });
		const starting = closed.start();
		await closed.close();
		await expect(starting).rejects.toThrow("closed");
		const ended = stream();
		const eof = new LegacySseTransport({ url: base, fetch: async () => sse(ended.body) });
		const awaitingEof = eof.start();
		ended.end();
		await expect(awaitingEof).rejects.toThrow("stream ended");
		const delayed = stream();
		const timeout = new LegacySseTransport({ url: base, fetch: async () => sse(delayed.body), endpointTimeoutMs: 15 });
		await expect(timeout.start()).rejects.toThrow("timed out");
		expect(delayed.cancelled()).toBe(true);
	});

	it("bounds an unsuccessful GET body and releases it before closing", async () => {
		const errorBody = stream();
		const transport = new LegacySseTransport({
			url: base,
			fetch: async () => {
				queueMicrotask(() => errorBody.write("error".repeat(3_000)));
				return new Response(errorBody.body, { status: 500 });
			},
		});
		await expect(transport.start()).rejects.toMatchObject({ status: 500 });
		expect(errorBody.cancelled()).toBe(true);
	});

	it("refreshes authorization once and suppresses a cancelled POST replay", async () => {
		const incoming = stream();
		let token = "old";
		const abort = new AbortController();
		let posts = 0;
		const fetch: McpFetch = async (_url, init) => {
			if (init?.method === "GET") return sse(incoming.body);
			posts++;
			return new Response(null, { status: 401 });
		};
		const transport = new LegacySseTransport({
			url: base,
			fetch,
			authProvider: {
				async token() {
					return token;
				},
				async onUnauthorized() {
					token = "new";
					abort.abort();
				},
			},
		});
		const ready = transport.start();
		incoming.write(event("endpoint", "/post"));
		await ready;
		await expect(
			transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }, { signal: abort.signal }),
		).rejects.toBeInstanceOf(McpAbortError);
		expect(posts).toBe(1);
		await transport.close();
	});

	it("uses the refreshed token for one challenged GET and one challenged POST", async () => {
		const incoming = stream();
		let token = "old";
		const attempts = { GET: 0, POST: 0 };
		const fetch: McpFetch = async (_url, init) => {
			const method = init?.method === "POST" ? "POST" : "GET";
			attempts[method]++;
			const headers = new Headers(init?.headers);
			if (headers.get("authorization") === "Bearer old") return new Response(null, { status: 401 });
			return method === "GET" ? sse(incoming.body) : new Response(null, { status: 202 });
		};
		const transport = new LegacySseTransport({
			url: base,
			fetch,
			authProvider: {
				async token() {
					return token;
				},
				async onUnauthorized() {
					token = "new";
				},
			},
		});
		const ready = transport.start();
		await vi.waitFor(() => expect(attempts.GET).toBe(2));
		incoming.write(event("endpoint", "/post"));
		await ready;
		token = "old";
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(attempts).toEqual({ GET: 2, POST: 2 });
		await transport.close();
	});

	it("does not follow HTTP redirects or replay failed POSTs", async () => {
		const incoming = stream();
		let posts = 0;
		const transport = new LegacySseTransport({
			url: base,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return sse(incoming.body);
				posts++;
				return new Response(null, { status: 302, headers: { location: "https://evil.test/collect" } });
			},
		});
		const ready = transport.start();
		incoming.write(event("endpoint", "/post"));
		await ready;
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({ status: 302 });
		expect(posts).toBe(1);
		await transport.close();
	});

	it("bounds incoming events and closes the transport on a broken stream", async () => {
		const incoming = stream();
		const transport = new LegacySseTransport({ url: base, fetch: async () => sse(incoming.body), maxMessageBytes: 64 });
		const errors: Error[] = [];
		let closed = 0;
		transport.onError((error) => errors.push(error));
		transport.onClose(() => closed++);
		const ready = transport.start();
		incoming.write(event("endpoint", "/post"));
		await ready;
		incoming.write(event("message", "x".repeat(100)));
		await vi.waitFor(() => expect(closed).toBe(1));
		expect(errors[0]?.message).toMatch(/exceeds 64 bytes/);
		await expect(transport.send({ jsonrpc: "2.0", method: "ping" })).rejects.toThrow("closed");
	});
});
