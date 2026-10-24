import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { calculateCost } from "../src/models.ts";
import { withOpenCodeSessionHeader } from "../src/providers/opencode-headers.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	systemPrompt: "Stable agent instructions",
	messages: [{ role: "user", content: "A changing task", timestamp: 0 }],
});
const model: Model<"openai-responses"> = {
	id: "capable-model",
	name: "Capable model",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true },
};
const options: StreamOptions = {
	apiKey: "sk-fake",
	cacheRetention: "short",
	instructionCacheRetention: "long",
	sessionId: "session-1",
};
const terminal = {
	type: "response.completed",
	response: {
		id: "resp_test",
		status: "completed",
		output: [],
		usage: {
			input_tokens: 12000,
			output_tokens: 10,
			total_tokens: 12010,
			input_tokens_details: {
				cached_tokens: 4000,
				cache_write_tokens: 7000,
				cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
			},
		},
	},
};
function response(): Response {
	return new Response(`data: ${JSON.stringify(terminal)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
interface Payload {
	input: { role?: string; content?: { prompt_cache_breakpoint?: { ttl: string } }[] | string }[];
	prompt_cache_options?: { mode?: string; ttl?: string };
	prompt_cache_retention?: string;
	prompt_cache_key?: string;
}
async function capture(target = model, overrides: StreamOptions = {}): Promise<Payload> {
	let payload: Payload | undefined;
	const result = await streamSimple(target, context, {
		...options,
		...overrides,
		fetch: async (_url, init) => {
			payload = JSON.parse(String(init?.body)) as Payload;
			return response();
		},
	}).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(payload).toBeDefined();
	return payload!;
}

describe("layered provider caching", () => {
	it("writes leading instructions for 12h and leaves history on implicit 30m caching", async () => {
		const payload = await capture();
		expect(payload.input[0].content).toEqual([
			{
				type: "input_text",
				text: "Stable agent instructions",
				prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
			},
		]);
		expect(JSON.stringify(payload.input[1])).not.toContain("prompt_cache_breakpoint");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_key).toBe("session-1");
	});
	it("keeps legacy Pi options working without adding a long instruction write", async () => {
		const payload = await capture(model, { instructionCacheRetention: undefined, cacheRetention: "long" });
		expect(payload.prompt_cache_options).toEqual({ ttl: "12h" });
		expect(payload.input[0].content).toBe("Stable agent instructions");
	});
	it("honors none even when instructions request long retention", async () => {
		const payload = await capture(model, { cacheRetention: "none" });
		expect(payload.prompt_cache_options).toEqual({ mode: "explicit" });
		expect(payload.prompt_cache_key).toBeUndefined();
		expect(JSON.stringify(payload.input)).not.toContain("prompt_cache_breakpoint");
	});
	it.each(["xai", "opencode", "opencode-go", "custom-provider"])(
		"does not guess TTL support for %s",
		async (provider) => {
			const payload = await capture(
				{ ...model, provider, baseUrl: "https://proxy.example/v1", compat: {} },
				{ cacheRetention: "long" },
			);
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_options).toBeUndefined();
			expect(JSON.stringify(payload.input)).not.toContain("prompt_cache_breakpoint");
			expect(payload.prompt_cache_key).toBe("session-1");
		},
	);
	it("honors capability overrides for custom models", async () => {
		const payload = await capture({ ...model, provider: "custom", baseUrl: "https://proxy.example/v1" });
		expect(JSON.stringify(payload.input)).toContain('"ttl":"12h"');
	});
	it("omits API cache fields for ChatGPT subscription credentials", async () => {
		const payload = await capture(model, { apiKey: "subscription-token" });
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(JSON.stringify(payload.input)).not.toContain("prompt_cache_breakpoint");
	});
	it("preserves the OpenCode session wrapper through direct HTTP", async () => {
		let headers = new Headers();
		const wrapped = withOpenCodeSessionHeader({ stream, streamSimple });
		const result = await wrapped
			.streamSimple({ ...model, provider: "opencode" }, context, {
				...options,
				fetch: async (_url, init) => {
					headers = new Headers(init?.headers);
					return response();
				},
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(headers.get("x-opencode-session")).toBe("session-1");
	});
	it("accounts for mixed writes exactly once, including tiered pricing", async () => {
		const result = await stream(model, context, { ...options, fetch: async () => response() }).result();
		expect(result.usage).toMatchObject({
			input: 1000,
			cacheRead: 4000,
			cacheWrite: 7000,
			cacheWrite12h: 4000,
			totalTokens: 12010,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.01517, 10);
		calculateCost(
			{
				...model,
				cost: {
					...model.cost,
					tiers: [{ inputTokensAbove: 10000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 }],
				},
			},
			result.usage,
		);
		expect(result.usage.cost.total).toBeCloseTo(0.03034, 10);
	});
	it("uses Anthropic 1h instructions before 5m history", async () => {
		let payload:
			| {
					system: { cache_control?: { ttl?: string } }[];
					messages: { content: { cache_control?: { ttl?: string } }[] }[];
			  }
			| undefined;
		await anthropicStream(getBuiltinModel("anthropic", "claude-haiku-4-5"), context, {
			...options,
			onPayload: (value) => {
				payload = value as typeof payload;
				throw new Error("captured before network");
			},
		}).result();
		expect(payload?.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload?.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("Responses HTTP transport", () => {
	it("merges headers case-insensitively and accepts payload replacement", async () => {
		let headers = new Headers();
		let body: unknown;
		let path: string | undefined;
		let status: number | undefined;
		const result = await stream({ ...model, headers: { "X-Custom": "old" } }, context, {
			...options,
			headers: { authorization: "Bearer override", "User-Agent": null, "x-custom": "new" },
			onPayload: () => ({ model: "replacement", stream: true }),
			onResponse: (value) => {
				status = value.status;
			},
			fetch: async (url, init) => {
				path = String(url);
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return response();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(path).toBe("https://api.openai.com/v1/responses");
		expect(body).toEqual({ model: "replacement", stream: true });
		expect(headers.get("authorization")).toBe("Bearer override");
		expect(headers.get("user-agent")).toBeNull();
		expect(headers.get("x-custom")).toBe("new");
		expect(status).toBe(200);
	});
	it("parses split UTF-8, CRLF, comments, and multiline SSE data", async () => {
		const unicodeTerminal = { ...terminal, response: { ...terminal.response, id: "resp_שלום" } };
		const bytes = new TextEncoder().encode(
			`: heartbeat\r\ndata: ${JSON.stringify(unicodeTerminal).slice(0, -1)}\r\ndata: }\r\n\r\n`,
		);
		const result = await stream(model, context, {
			...options,
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
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.responseId).toBe("resp_שלום");
	});

	it("preserves named SSE errors without retrying the stream", async () => {
		const result = await stream(model, context, {
			...options,
			fetch: async () => new Response('event: error\ndata: {"message":"gateway failure"}\n\n'),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gateway failure");
	});

	it("closes an unread body when the response callback fails", async () => {
		let cancelled = false;
		const result = await stream(model, context, {
			...options,
			onResponse: () => {
				throw new Error("callback failed");
			},
			fetch: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		}).result();
		expect(result.errorMessage).toContain("callback failed");
		expect(cancelled).toBe(true);
	});

	it("times out a custom fetch that ignores cancellation", async () => {
		const result = await stream(model, context, {
			...options,
			timeoutMs: 10,
			fetch: async () => new Promise<Response>(() => {}),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});
	it("retries rejected HTTP requests but never restarts a partial generation", async () => {
		let attempts = 0;
		const result = await stream(model, context, {
			...options,
			maxRetries: 1,
			fetch: async () =>
				++attempts === 1 ? new Response("busy", { status: 429, headers: { "retry-after-ms": "0" } }) : response(),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(attempts).toBe(2);
		attempts = 0;
		const incomplete = await stream(model, context, {
			...options,
			maxRetries: 2,
			fetch: async () => {
				attempts++;
				return new Response('data: {"type":"response.created","response":{"id":"partial"}}\n\n');
			},
		}).result();
		expect(incomplete.stopReason).toBe("error");
		expect(attempts).toBe(1);
	});
	it("times out and cancels an idle response body", async () => {
		let cancelled = false;
		const result = await stream(model, context, {
			...options,
			timeoutMs: 10,
			fetch: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		expect(cancelled).toBe(true);
	});
	it("reports caller aborts as aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const result = await stream(model, context, {
			...options,
			signal: controller.signal,
			fetch: async () => {
				called = true;
				return response();
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(called).toBe(false);
	});
});
