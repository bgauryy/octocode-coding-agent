import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test",
	name: "test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://first.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const context = normalizeContext({
	messages: [{ role: "user", content: "test", timestamp: 0 }],
});
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;
const terminal = {
	type: "response.completed",
	response: { id: "r1", status: "completed", output: [] },
};

class MockSocket extends EventTarget {
	static instances: MockSocket[] = [];
	static pauseFirst = false;
	readyState = 1;
	frames: Record<string, unknown>[] = [];
	readonly url: string;
	constructor(url: string) {
		super();
		this.url = url;
		MockSocket.instances.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(raw: string) {
		this.frames.push(JSON.parse(raw));
		if (MockSocket.pauseFirst && this === MockSocket.instances[0]) return;
		queueMicrotask(() => this.complete());
	}
	complete() {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(terminal) }));
	}
	close() {
		this.readyState = 3;
	}
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	MockSocket.instances = [];
	MockSocket.pauseFirst = false;
});

describe("Codex protocol and cache regressions", () => {
	it.each(["\r\n", "\r", "\n"])("parses %j lines split across UTF-8 byte chunks", async (newline) => {
		const seen: unknown[] = [];
		const event = {
			type: "response.created",
			response: { id: "r1", note: "שלום" },
		};
		const bytes = new TextEncoder().encode(
			`: heartbeat${newline}data: ${JSON.stringify(event)}${newline}${newline}data: ${JSON.stringify(terminal)}${newline}${newline}`,
		);
		const result = await stream(model, context, {
			apiKey: token,
			transport: "sse",
			onProviderStreamEvent: (value) => {
				seen.push(value);
			},
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
							controller.close();
						},
					}),
				),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(seen).toEqual([event, terminal]);
	});

	it("cancels a response when its response hook fails without retrying", async () => {
		const cancel = vi.fn();
		const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })));
		const result = await stream(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 2,
			onResponse: async () => {
				throw new Error("hook failure");
			},
			fetch,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("hook failure");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("honors environment cache disabling for SSE affinity and WebSocket reuse", async () => {
		let body: unknown;
		const result = await stream(model, context, {
			apiKey: token,
			sessionId: "disabled",
			transport: "sse",
			env: { OCTOCODE_CACHE_RETENTION: "none" },
			onPayload: (payload) => {
				body = payload;
			},
			fetch: async () => new Response(`data: ${JSON.stringify(terminal)}\n\n`),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body).not.toHaveProperty("prompt_cache_key", "disabled");
		vi.stubGlobal("WebSocket", MockSocket);
		for (let i = 0; i < 2; i++) {
			await stream(model, context, {
				apiKey: token,
				sessionId: "disabled",
				env: { OCTOCODE_CACHE_RETENTION: "none" },
			}).result();
		}
		expect(MockSocket.instances).toHaveLength(2);
		expect(MockSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
	});

	it("uses cached continuation with omitted transport", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		for (let i = 0; i < 2; i++) {
			await stream(model, context, {
				apiKey: token,
				sessionId: "default",
			}).result();
		}
		expect(MockSocket.instances).toHaveLength(1);
		expect(MockSocket.instances[0].frames[1]).toMatchObject({
			previous_response_id: "r1",
			input: [],
		});
	});

	it.each(["endpoint", "headers", "proxy"])("reconnects when %s changes", async (change) => {
		vi.stubGlobal("WebSocket", MockSocket);
		const options = { apiKey: token, sessionId: "routing", env: {} };
		await stream(model, context, options).result();
		await stream(change === "endpoint" ? { ...model, baseUrl: "https://second.invalid" } : model, context, {
			...options,
			...(change === "headers" ? { headers: { "x-routing": "new" } } : {}),
			...(change === "proxy" ? { env: { HTTPS_PROXY: "http://proxy.invalid:8080" } } : {}),
		}).result();
		expect(MockSocket.instances).toHaveLength(2);
		expect(MockSocket.instances[0].readyState).toBe(3);
		expect(MockSocket.instances[1].frames[0]).not.toHaveProperty("previous_response_id");
		if (change === "endpoint") expect(MockSocket.instances[1].url).toBe("wss://second.invalid/codex/responses");
	});

	it("does not close an in-flight socket when another request changes endpoint", async () => {
		vi.stubGlobal("WebSocket", MockSocket);
		MockSocket.pauseFirst = true;
		const options = { apiKey: token, sessionId: "busy", env: {} };
		const first = stream(model, context, options).result();
		await vi.waitFor(() => expect(MockSocket.instances[0]?.frames).toHaveLength(1));
		const second = await stream({ ...model, baseUrl: "https://second.invalid" }, context, options).result();
		expect(second.stopReason).toBe("stop");
		expect(MockSocket.instances[0].readyState).toBe(1);
		expect(MockSocket.instances[1].url).toBe("wss://second.invalid/codex/responses");
		expect(MockSocket.instances[1].readyState).toBe(3);
		MockSocket.instances[0].complete();
		expect((await first).stopReason).toBe("stop");
	});
});
