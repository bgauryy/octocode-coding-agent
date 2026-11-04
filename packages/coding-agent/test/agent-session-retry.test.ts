import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { RATE_LIMIT_MIN_RETRIES, RATE_LIMIT_WINDOW_MS } from "../src/core/agent-session/retry.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		maxAgentDelayMs?: number;
		delayAssistantMessageEndMs?: number;
		errorMessage?: string;
		retryAfterMs?: number;
		baseDelayMs?: number;
	}) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const maxAgentDelayMs = options?.maxAgentDelayMs ?? 60000;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: options?.errorMessage ?? "500 internal server error",
							...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries, baseDelayMs: options?.baseDelayMs ?? 1, maxAgentDelayMs },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = await createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("caps agent retry delay", async () => {
		// Regression for #8826.
		const created = await createSession({ failCount: 4, maxRetries: 5, maxAgentDelayMs: 5 });
		const delays: number[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") delays.push(event.delayMs);
		});

		await created.session.prompt("Test");

		expect(delays).toEqual([1, 2, 4, 5]);
	});

	it("spreads rate-limit retries so concurrent sessions sharing a quota do not retry in lockstep", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0.5);
		try {
			const created = await createSession({
				failCount: 3,
				maxRetries: 3,
				baseDelayMs: 4,
				errorMessage: "429 Quota or rate limit exceeded",
			});
			const delays: number[] = [];
			created.session.subscribe((event) => {
				if (event.type === "auto_retry_start") delays.push(event.delayMs);
			});
			await created.session.prompt("Test");
			// Backoff 4, 8, 16 ms plus up to half again, by Math.random().
			expect(delays).toEqual([4, 12, 20]);
		} finally {
			random.mockRestore();
		}
	});

	it("waits at least the provider retry-after on a rate limit, capped by maxAgentDelayMs", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			const created = await createSession({
				failCount: 2,
				maxRetries: 3,
				baseDelayMs: 1,
				maxAgentDelayMs: 40,
				errorMessage: "429 rate_limit_error",
				retryAfterMs: 30,
			});
			const delays: number[] = [];
			created.session.subscribe((event) => {
				if (event.type === "auto_retry_start") delays.push(event.delayMs);
			});
			await created.session.prompt("Test");
			expect(delays).toEqual([30, 30]);

			const capped = await createSession({
				failCount: 1,
				maxRetries: 3,
				baseDelayMs: 1,
				maxAgentDelayMs: 40,
				errorMessage: "429 rate_limit_error",
				retryAfterMs: 5000,
			});
			const cappedDelays: number[] = [];
			capped.session.subscribe((event) => {
				if (event.type === "auto_retry_start") cappedDelays.push(event.delayMs);
			});
			await capped.session.prompt("Test");
			expect(cappedDelays).toEqual([40]);
		} finally {
			random.mockRestore();
		}
	});

	it("gives rate limits a larger retry budget than other errors", async () => {
		const limited = await createSession({ failCount: 99, maxRetries: 2, errorMessage: "429 rate limit" });
		await limited.session.prompt("Test");
		expect(limited.getCallCount()).toBe(1 + RATE_LIMIT_MIN_RETRIES);

		const other = await createSession({ failCount: 99, maxRetries: 2 });
		await other.session.prompt("Test");
		expect(other.getCallCount()).toBe(3);
	});

	it("does not raise the budget when retries are configured off", async () => {
		const created = await createSession({ failCount: 99, maxRetries: 0, errorMessage: "429 rate limit" });
		await created.session.prompt("Test");
		expect(created.getCallCount()).toBe(1);
	});

	describe("capacity and transport failures", () => {
		it.each([
			"overloaded_error",
			"529 overloaded",
			"503 Service Unavailable",
			"502 Bad Gateway",
			"504 status code (no body)",
			"520 status code (no body)",
			"524 status code (no body)",
			"server_busy",
			"The model is at capacity",
			"The service is temporarily unavailable",
			"read ECONNRESET",
			"connection reset by peer",
			"other side closed",
			"socket hang up",
			"websocket closed: 1006",
			"terminated",
			"Anthropic stream ended before message_stop",
			"Stream ended without finish_reason",
		])("gives %s the rate-limit budget", async (errorMessage) => {
			const created = await createSession({ failCount: 99, maxRetries: 2, errorMessage });
			await created.session.prompt("Test");
			expect(created.getCallCount()).toBe(1 + RATE_LIMIT_MIN_RETRIES);
		});

		it.each([
			"getaddrinfo ENOTFOUND api.example.com",
			"request to https://api.example.com failed, reason: ",
			"500 Internal error",
			"Request timed out",
			"Provider returned error",
		])("keeps the configured budget for %s", async (errorMessage) => {
			const created = await createSession({ failCount: 99, maxRetries: 2, baseDelayMs: 4, errorMessage });
			const delays: number[] = [];
			created.session.subscribe((event) => {
				if (event.type === "auto_retry_start") delays.push(event.delayMs);
			});
			await created.session.prompt("Test");
			expect(created.getCallCount()).toBe(3);
			expect(delays).toEqual([4, 8]);
		});

		it("leaves retries off when maxRetries is 0, and fails terminal quota text fast", async () => {
			const off = await createSession({ failCount: 99, maxRetries: 0, errorMessage: "503 Service Unavailable" });
			await off.session.prompt("Test");
			expect(off.getCallCount()).toBe(1);

			const quota = await createSession({ failCount: 99, maxRetries: 3, errorMessage: "503 insufficient_quota" });
			await quota.session.prompt("Test");
			expect(quota.getCallCount()).toBe(1);
		});

		it("spreads the delays and treats retry-after as a floor", async () => {
			const random = vi.spyOn(Math, "random").mockReturnValue(1);
			try {
				const spread = await createSession({ failCount: 2, maxRetries: 3, baseDelayMs: 4, errorMessage: "overloaded" });
				const delays: number[] = [];
				spread.session.subscribe((event) => {
					if (event.type === "auto_retry_start") delays.push(event.delayMs);
				});
				await spread.session.prompt("Test");
				expect(delays).toEqual([6, 12]);
			} finally {
				random.mockRestore();
			}
			const zero = vi.spyOn(Math, "random").mockReturnValue(0);
			try {
				const floored = await createSession({
					failCount: 1,
					maxRetries: 3,
					baseDelayMs: 1,
					errorMessage: "503 Service Unavailable",
					retryAfterMs: 30,
				});
				const delays: number[] = [];
				floored.session.subscribe((event) => {
					if (event.type === "auto_retry_start") delays.push(event.delayMs);
				});
				await floored.session.prompt("Test");
				expect(delays).toEqual([30]);
			} finally {
				zero.mockRestore();
			}
		});
	});

	describe("the retry window", () => {
		/** Each provider call takes this long, as a stalled stream does before it fails. */
		function everyCallTakes(ms: number, session: { subscribe: AgentSession["subscribe"] }) {
			const real = Date.now.bind(Date);
			let offset = 0;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
			session.subscribe((event) => {
				if (event.type === "agent_start") offset += ms;
			});
			return clock;
		}

		it("counts wall-clock time from the first failure, so a stream stall spends it", async () => {
			const created = await createSession({ failCount: 99, maxRetries: 1, errorMessage: "503 Service Unavailable" });
			const clock = everyCallTakes(RATE_LIMIT_WINDOW_MS / 2, created.session);
			try {
				await created.session.prompt("Test");
			} finally {
				clock.mockRestore();
			}
			// Failures at about 0.5, 1.0 and 1.5 windows from the start: the third call fails a full window after the first.
			expect(created.getCallCount()).toBe(3);
		});

		it("always allows the configured attempts, however long they took", async () => {
			const created = await createSession({ failCount: 99, maxRetries: 3, errorMessage: "429 rate limit" });
			const clock = everyCallTakes(RATE_LIMIT_WINDOW_MS * 2, created.session);
			try {
				await created.session.prompt("Test");
			} finally {
				clock.mockRestore();
			}
			expect(created.getCallCount()).toBe(4);
		});

		it("pulls a raised attempt into what is left of the window, but not below retry-after", async () => {
			const start = Date.now();
			let now = start;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			try {
				const created = await createSession({
					failCount: 2,
					maxRetries: 1,
					baseDelayMs: 1,
					maxAgentDelayMs: 200,
					errorMessage: "503 Service Unavailable",
					retryAfterMs: 50,
				});
				const delays: number[] = [];
				created.session.subscribe((event) => {
					if (event.type === "auto_retry_start") {
						delays.push(event.delayMs);
						// Leave 5 ms of the window, less than the provider asked for.
						now = start + RATE_LIMIT_WINDOW_MS - 5;
					}
				});
				await created.session.prompt("Test");
				expect(delays.length).toBe(2);
				expect(delays[1]).toBeGreaterThanOrEqual(50);
			} finally {
				clock.mockRestore();
			}
		});
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = await createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = await createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
