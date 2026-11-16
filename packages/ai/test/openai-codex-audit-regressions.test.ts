import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
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
const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] });
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;
const terminal = { type: "response.completed", response: { id: "r1", status: "completed", output: [] } };
const response = () =>
	new Response(`data: ${JSON.stringify(terminal)}\n\n`, { headers: { "content-type": "text/event-stream" } });
describe("Codex protocol and cache regressions", () => {
	it.each([undefined, "auto", "sse"] as const)(
		"uses HTTP with transport %s and accepts response.done",
		async (transport) => {
			const fetch = vi.fn(
				async () =>
					new Response(
						`data: ${JSON.stringify({ ...terminal, type: "response.done", response: { ...terminal.response, end_turn: true } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			);
			const result = await stream(model, normalizeContext({ messages: [] }), {
				apiKey: token,
				transport,
				fetch,
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.endTurn).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe("https://first.invalid/codex/responses");
			expect(JSON.parse(String(init.body))).toMatchObject({
				store: false,
				instructions: "You are a helpful assistant.",
				input: [],
			});
		},
	);
	it.each(["\r\n", "\r", "\n"])("parses %j lines split across UTF-8 byte chunks", async (newline) => {
		const seen: unknown[] = [];
		const event = { type: "response.created", response: { id: "r1", note: "שלום" } };
		const bytes = new TextEncoder().encode(
			`: heartbeat${newline}data: ${JSON.stringify(event)}${newline}${newline}data: ${JSON.stringify(terminal)}${newline}${newline}`,
		);
		const result = await stream(model, context, {
			apiKey: token,
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
					{ headers: { "content-type": "text/event-stream" } },
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
	it("honors environment cache disabling for HTTP affinity", async () => {
		let body: unknown;
		let headers = new Headers();
		const result = await stream(model, context, {
			apiKey: token,
			sessionId: "disabled",
			env: { OCTOCODE_CACHE_RETENTION: "none" },
			onPayload: (payload) => {
				body = payload;
			},
			fetch: async (_input, init) => {
				headers = new Headers(init?.headers);
				return response();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(body).not.toHaveProperty("prompt_cache_key");
		expect(headers.has("session-id")).toBe(false);
	});
	it.each(["endpoint", "headers"])("uses the current %s on every HTTP request", async (change) => {
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
			return response();
		};
		const options = { apiKey: token, sessionId: "routing", fetch };
		await stream(model, context, options).result();
		const result = await stream(
			change === "endpoint" ? { ...model, baseUrl: "https://second.invalid" } : model,
			context,
			{ ...options, ...(change === "headers" ? { headers: { "x-routing": "new" } } : {}) },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[1].body).not.toHaveProperty("previous_response_id");
		if (change === "endpoint") expect(requests[1].url).toBe("https://second.invalid/codex/responses");
		else expect(requests[1].headers.get("x-routing")).toBe("new");
	});
});
