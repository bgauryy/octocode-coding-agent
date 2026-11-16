import { mkdtempSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	stream as streamOpenAICodexResponses,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const originalAgentDir = process.env.OCTOCODE_CODING_AGENT_DIR;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) {
		delete process.env.OCTOCODE_CODING_AGENT_DIR;
	} else {
		process.env.OCTOCODE_CODING_AGENT_DIR = originalAgentDir;
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function decodeCodexRequestBody(body: RequestInit["body"] | undefined): Record<string, unknown> | null {
	if (typeof body === "string") {
		return JSON.parse(body) as Record<string, unknown>;
	}
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Record<string, unknown>;
	}
	return null;
}

function buildSSEPayload({
	status,
	includeDone = false,
	endTurn,
}: {
	status: "completed" | "incomplete";
	includeDone?: boolean;
	endTurn?: boolean;
}): string {
	const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";
	const events = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: terminalType,
			response: {
				status,
				end_turn: endTurn,
				incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	];

	if (includeDone) {
		events.push("data: [DONE]");
	}

	return `${events.join("\n\n")}\n\n`;
}

describe("openai-codex streaming", () => {
	it("streams SSE responses and forwards raw provider events", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("Octocode");
				expect(headers?.get("User-Agent")).toBe(`octocode (${platform()} ${release()}; ${arch()})`);
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const providerEvents: unknown[] = [];
		const providerEventModels: Model<Api>[] = [];
		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			onProviderStreamEvent: (event, eventModel) => {
				providerEvents.push(event);
				providerEventModels.push(eventModel);
			},
		});
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find((c) => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
		expect(providerEvents.map((event) => (event as { type?: string }).type)).toEqual([
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(providerEventModels).toEqual([model, model, model, model, model]);
	});

	it("processes a terminal SSE event without a trailing blank line", async () => {
		const token = mockToken();
		const sse = buildSSEPayload({ status: "completed" }).trimEnd();
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});
		const resultStream = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		});
		const result = await resultStream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
	});

	it("does not retry a non-retryable HTTP error, and keeps its status", async () => {
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] });
		let calls = 0;
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 3,
			fetch: async () => {
				calls++;
				return new Response(JSON.stringify({ error: { message: "Invalid request: unknown parameter" } }), {
					status: 400,
				});
			},
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid request");
	});

	it("completes after response.completed even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed", includeDone: true, endTurn: false });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for completed SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("stop");
		expect(result.endTurn).toBe(false);
	});

	it("maps response.incomplete to stopReason length even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "incomplete" });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for incomplete SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("length");
	});

	it("aborts SSE fetch after the configured HTTP timeout when response headers do not arrive", async () => {
		const token = mockToken();

		const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			const signal = init?.signal;
			if (!signal) {
				throw new Error("Expected SSE fetch to receive an abort signal");
			}

			return new Promise<Response>((_, reject) => {
				const onAbort = () => {
					const reason = signal.reason;
					reject(reason instanceof Error ? reason : new Error("SSE fetch aborted"));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			timeoutMs: 10,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request timed out after 10ms");
	});

	it("aborts SSE body reads after response headers arrive", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const timers: ReturnType<typeof setTimeout>[] = [];
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const enqueue = (chunk: string) => {
					if (!cancelled) controller.enqueue(encoder.encode(chunk));
				};
				enqueue(
					`${[
						`data: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
						})}`,
						`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
						`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "one" })}`,
					].join("\n\n")}\n\n`,
				);
				timers.push(
					setTimeout(() => {
						enqueue(
							`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "two" })}\n\n`,
						);
					}, 10),
				);
				timers.push(
					setTimeout(() => {
						if (cancelled) return;
						enqueue(
							`${[
								`data: ${JSON.stringify({
									type: "response.output_item.done",
									output_index: 0,
									item: {
										type: "message",
										id: "msg_1",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "onetwo" }],
									},
								})}`,
								`data: ${JSON.stringify({
									type: "response.completed",
									response: {
										status: "completed",
										usage: {
											input_tokens: 5,
											output_tokens: 3,
											total_tokens: 8,
											input_tokens_details: { cached_tokens: 0 },
										},
									},
								})}`,
							].join("\n\n")}\n\n`,
						);
						controller.close();
					}, 20),
				);
			},
			cancel() {
				cancelled = true;
				for (const timer of timers) clearTimeout(timer);
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});
		const controller = new AbortController();
		const events: string[] = [];

		const resultStream = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			signal: controller.signal,
		});
		for await (const event of resultStream) {
			events.push(event.type === "text_delta" ? `text_delta:${event.delta}` : event.type);
			if (event.type === "text_delta" && event.delta === "one") {
				controller.abort();
			}
		}

		const result = await resultStream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("This operation was aborted");
		expect(events).toContain("text_delta:one");
		expect(events).not.toContain("text_delta:two");
		expect(cancelled).toBe(true);
	});

	it.each([undefined, "sibling-prefix"])(
		"keeps SSE session identity separate from cache group %s",
		async (promptCacheKey) => {
			const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
			process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;

			const payload = Buffer.from(
				JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
				"utf8",
			).toString("base64");
			const token = `aaa.${payload}.bbb`;

			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sse));
					controller.close();
				},
			});

			const sessionId = "test-session-123";
			const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					const headers = init?.headers instanceof Headers ? init.headers : undefined;
					// Verify sessionId is set in headers
					expect(headers?.get("session-id")).toBe(sessionId);
					expect(headers?.has("session_id")).toBe(false);
					expect(headers?.get("x-client-request-id")).toBe(sessionId);

					// Verify sessionId is set in request body as prompt_cache_key
					const body = decodeCodexRequestBody(init?.body);
					expect(body?.prompt_cache_key).toBe(promptCacheKey ?? sessionId);

					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			});

			vi.stubGlobal("fetch", fetchMock);

			const model: Model<"openai-codex-responses"> = {
				id: "gpt-5.1-codex",
				name: "GPT-5.1 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};

			const context = normalizeContext({
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			});

			const streamResult = streamOpenAICodexResponses(model, context, {
				apiKey: token,
				sessionId,
				promptCacheKey,
				transport: "sse",
			});
			await streamResult.result();
		},
	);

	it("omits SSE cache affinity when cacheRetention is none", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | null = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : undefined;
				capturedBody = decodeCodexRequestBody(init?.body);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			cacheRetention: "none",
			sessionId: "one-off-summary",
			transport: "sse",
		}).result();

		expect(capturedHeaders?.has("session-id")).toBe(false);
		expect(capturedHeaders?.has("x-client-request-id")).toBe(false);
		expect(capturedBody).not.toHaveProperty("prompt_cache_key");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const token = mockToken();
		const sessionId = "x".repeat(67);
		let capturedPayload: { prompt_cache_key?: string } | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
								controller.close();
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			sessionId,
			onPayload: (payload) => {
				capturedPayload = payload as { prompt_cache_key?: string };
			},
		}).result();

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("clamps Codex session-id header to 64 characters", async () => {
		const token = mockToken();
		const sessionId = "x".repeat(67);
		let capturedHeaders: Headers | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : undefined;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			sessionId,
		}).result();

		expect(capturedHeaders?.get("session-id")).toBe("x".repeat(64));
		expect(capturedHeaders?.get("x-client-request-id")).toBe("x".repeat(64));
	});

	it("lets model and caller headers override originator and User-Agent", async () => {
		const token = mockToken();
		let capturedHeaders: Headers | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : undefined;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
			headers: { originator: "my-app" },
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			headers: { "user-agent": "my-app/1.0", Authorization: "Bearer ignored" },
		}).result();

		expect(capturedHeaders?.get("originator")).toBe("my-app");
		expect(capturedHeaders?.get("User-Agent")).toBe("my-app/1.0");
		expect(capturedHeaders?.get("Authorization")).toBe(`Bearer ${token}`);
	});

	it("preserves gpt-5.5 xhigh reasoning effort from simple options", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sse = buildSSEPayload({ status: "completed" });
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		let requestedReasoning: unknown;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = decodeCodexRequestBody(init?.body);
				requestedReasoning = body?.reasoning;
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoning: "xhigh",
			transport: "sse",
		}).result();

		expect(requestedReasoning).toEqual({ effort: "xhigh", summary: "auto" });
	});

	it("forwards required tool choice", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let requestedToolChoice: unknown;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				requestedToolChoice = decodeCodexRequestBody(init?.body)?.tool_choice;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(sse));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		await streamOpenAICodexResponses(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "Do not call ping. Respond with text instead.", timestamp: Date.now() }],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			}),
			{ apiKey: token, transport: "sse", toolChoice: "required" },
		).result();

		expect(requestedToolChoice).toBe("required");
	});

	it("sets Codex strict mode explicitly and honors constrained sampling", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let requestedTools: Array<{ type?: string; name?: string; strict?: boolean | null }> | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(sse));
								controller.close();
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		await streamOpenAICodexResponses(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "Use a tool", timestamp: Date.now() }],
				tools: [
					{
						name: "optional",
						description: "Optional constrained sampling",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: false,
					},
					{
						name: "strict",
						description: "Strict constrained sampling",
						parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			}),
			{
				apiKey: token,
				transport: "sse",
				onPayload: (payload) => {
					requestedTools = (payload as { tools?: typeof requestedTools }).tools;
				},
			},
		).result();

		expect(requestedTools).toMatchObject([
			{ type: "function", name: "optional", strict: false },
			{ type: "function", name: "strict", strict: true },
		]);
	});

	it.each(["gpt-5.3-codex", "gpt-5.4", "gpt-5.5"])("clamps %s minimal reasoning effort to low", async (modelId) => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		let requestedReasoning: unknown;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = decodeCodexRequestBody(init?.body);
				requestedReasoning = body?.reasoning;

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: modelId,
			name: modelId,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { minimal: "low" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoningEffort: "minimal",
			transport: "sse",
		});
		await streamResult.result();
		expect(requestedReasoning).toEqual({ effort: "low", summary: "auto" });
	});

	it.each([
		["gpt-5.1-codex", "flex", 0.5],
		["gpt-5.1-codex", "priority", 2],
		["gpt-5.5", "flex", 0.5],
		["gpt-5.5", "priority", 2.5],
	] as const)(
		"uses the client-sent %s service tier for %s when Codex echoes default",
		async (modelId, serviceTier, multiplier) => {
			const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
			process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;
			const token = mockToken();
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: "default",
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sse));
					controller.close();
				},
			});

			const fetchMock = vi.fn(async (input: string | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			});
			vi.stubGlobal("fetch", fetchMock);

			const model: Model<"openai-codex-responses"> = {
				id: modelId,
				name: modelId === "gpt-5.5" ? "GPT-5.5" : "GPT-5.1 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};

			const context = normalizeContext({
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			});

			const result = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				serviceTier,
				transport: "sse",
			}).result();

			expect(result.usage.cost.input).toBe(1 * multiplier);
			expect(result.usage.cost.output).toBe(2 * multiplier);
			expect(result.usage.cost.total).toBe(3 * multiplier);
		},
	);

	it("does not set session-id/x-client-request-id headers when sessionId is not provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octocode-codex-stream-"));
		process.env.OCTOCODE_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify headers are not set when sessionId is not provided
				expect(headers?.has("session-id")).toBe(false);
				expect(headers?.has("session_id")).toBe(false);
				expect(headers?.has("x-client-request-id")).toBe(false);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
		});
		await streamResult.result();
	});
	it.each([
		["retry-after-ms", () => ({ "content-type": "application/json", "retry-after-ms": "1500" }), 1500],
		["retry-after seconds", () => ({ "content-type": "application/json", "retry-after": "60" }), 60_000],
		[
			"retry-after HTTP date",
			() => ({ "content-type": "application/json", "retry-after": new Date(Date.now() + 45_000).toUTCString() }),
			45_000,
		],
	] as const)("uses %s for SSE retries", async (_name, makeHeaders, expectedDelay) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let codexRequests = 0;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			codexRequests++;
			if (codexRequests === 1) {
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "rate limited" } }), {
					status: 429,
					headers: makeHeaders(),
				});
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 1,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), expectedDelay);

		await vi.advanceTimersToNextTimerAsync();
		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(codexRequests).toBe(2);
	});

	it.each([429, 503])("fails immediately when a %i retry delay exceeds the limit", async (status) => {
		const token = mockToken();
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "temporarily_unavailable", message: "retry later" } }), {
					status,
					headers: { "content-type": "application/json", "retry-after": "2" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 3,
			maxRetryDelayMs: 1000,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			`Server requested 2s retry delay (max: 1s). ${status} {"error":{"code":"temporarily_unavailable","message":"retry later"}}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends SDK JSON HTTP request bodies", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });

		let capturedEncoding: string | null = null;
		let capturedBody: Uint8Array | string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers instanceof Headers ? init.headers : undefined;
			capturedEncoding = headers?.get("content-encoding") ?? null;
			capturedBody = init?.body as Uint8Array | string | undefined;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const largeText = "compress me ".repeat(400);
		await streamOpenAICodexResponses(
			model,
			normalizeContext({
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: largeText, timestamp: 1 }],
			}),
			{ apiKey: token, transport: "sse" },
		).result();

		expect(capturedEncoding).toBeNull();
		expect(typeof capturedBody).toBe("string");
		const decoded = JSON.parse(capturedBody as string) as {
			input: Array<{ content: Array<{ text: string }> }>;
		};
		expect(decoded.input[0].content[0].text).toBe(largeText);

		capturedEncoding = null;
		capturedBody = undefined;
		await streamOpenAICodexResponses(
			model,
			normalizeContext({
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			{ apiKey: token, transport: "sse" },
		).result();

		expect(capturedEncoding).toBeNull();
		expect(typeof capturedBody).toBe("string");
	});

	it("uses exponential backoff across repeated SSE retries without retry headers", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let codexRequests = 0;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			codexRequests++;
			if (codexRequests <= 3) {
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				});
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		const retryTimeoutDelays = () =>
			setTimeoutSpy.mock.calls
				.map((call) => call[1])
				.filter((delay): delay is number => delay === 500 || delay === 1000 || delay === 2000);

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 3,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		expect(retryTimeoutDelays()).toEqual([500]);

		await vi.advanceTimersToNextTimerAsync();
		expect(retryTimeoutDelays()).toEqual([500, 1000]);

		await vi.advanceTimersToNextTimerAsync();
		expect(retryTimeoutDelays()).toEqual([500, 1000, 2000]);

		await vi.advanceTimersToNextTimerAsync();
		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(codexRequests).toBe(4);
	});
});
