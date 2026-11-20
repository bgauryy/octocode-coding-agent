import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("clears the actual queue when a queue update listener dequeues immediately", async () => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) session.clearQueue();
		});
		await session.steer("cancel immediately");
		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		unsubscribe();
	});

	it("removes queued input by message identity rather than matching text", async () => {
		await session.steer("same");
		await session.followUp("same");
		const handle = Reflect.get(session, "_handleAgentEvent");
		await handle({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "same" }], timestamp: 0 },
		});
		expect(session.getSteeringMessages()).toEqual(["same"]);
		expect(session.getFollowUpMessages()).toEqual(["same"]);
		const queued = session.agent.peekQueuedMessages()[0];
		await handle({ type: "message_start", message: queued });
		expect(session.getSteeringMessages()).toEqual([]);
		expect(session.getFollowUpMessages()).toEqual(["same"]);
	});

	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])(
		"resumes queued work after compaction unless a completion handler stops it (stop=%s, retry=%s)",
		async (stop, retry) => {
			const ends: unknown[] = [];
			session.subscribe((event) => {
				if (event.type === "compaction_end") ends.push(event);
			});
			const emit = session.featureHost.emit.bind(session.featureHost);
			vi.spyOn(session.featureHost, "emit").mockImplementation(async (event) => {
				const result = await emit(event);
				if (stop && event.type === "session_compact") void session.abort();
				return result;
			});
			const policy = settingsManager.getCompactionSettings();
			settingsManager.getCompactionSettings = () => ({ ...policy, keepRecentTokens: 1 });
			const model = session.model!;
			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "message to compact" }],
				timestamp: now - 1000,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "assistant response to compact" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 100,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: now - 500,
			});
			session.agent.state.messages = sessionManager.buildSessionContext().messages;
			session.agent.streamFunction = (summaryModel) => {
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("compacted"),
							api: summaryModel.api,
							provider: summaryModel.provider,
							model: summaryModel.id,
							usage: {
								input: 10,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 10,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					});
				});
				return stream;
			};

			session.agent.followUp({
				role: "custom",
				customType: "test",
				content: [{ type: "text", text: "Queued custom" }],
				display: false,
				timestamp: Date.now(),
			});

			expect(session.pendingMessageCount).toBe(0);
			expect(session.agent.hasQueuedMessages()).toBe(true);

			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

			const runAutoCompaction = (
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
				}
			)._runAutoCompaction.bind(session);

			await expect(runAutoCompaction(retry ? "overflow" : "threshold", retry)).resolves.toBe(!stop);
			expect(ends).toContainEqual(
				expect.objectContaining({
					aborted: false,
					willRetry: retry && !stop,
					result: expect.objectContaining({
						summary: "No prior history.\n\n## Turn Context (split turn)\n\ncompacted",
					}),
				}),
			);

			expect(continueSpy).not.toHaveBeenCalled();
		},
	);

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);

		const firstKeptEntryId = sessionManager.getEntries()[0].id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, staleAssistant.usage.totalTokens, undefined, false);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should trigger threshold compaction for error messages using last successful usage", async () => {
		const model = session.model!;

		// A successful assistant message with token usage just over the compaction threshold.
		// Compute this from the selected model so generated catalog context-window changes do not break the test.
		const compactionSettings = settingsManager.getCompactionSettings();
		const thresholdTokens = (model.contextWindow ?? 200_000) - compactionSettings.reserveTokens + 1;
		const successfulAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large successful response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: thresholdTokens - 10_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: thresholdTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// An error message (e.g. 529 overloaded) with no useful usage data
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		};

		// Put both messages into agent state so estimateContextTokens can find the successful one
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "another prompt" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("should not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const model = session.model!;

		// An error message with no prior successful assistant in context
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should not trigger threshold compaction for error messages when only kept pre-compaction usage exists", async () => {
		const model = session.model!;
		const preCompactionTimestamp = Date.now() - 10_000;

		// A "kept" assistant message from before compaction with high usage
		const keptAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "kept response from before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preCompactionTimestamp,
		};

		// Record the kept assistant in the session and create a compaction after it
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = sessionManager.getEntries()[0].id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);

		// Post-compaction error message
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		// Agent state has the kept assistant (pre-compaction) and the error (post-compaction)
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user msg" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		// Should NOT compact because the only usage data is from a kept pre-compaction message
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("fails the run and keeps the overflowed reply out of the context when the limit blocks recovery", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			compactionPolicy: { keepRecentTokens: 1 },
		});
		try {
			const internals = harness.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
				_runDefaultCompaction: () => Promise<unknown>;
			};
			const summarize = vi
				.spyOn(internals, "_runDefaultCompaction")
				.mockRejectedValue(new Error("provider unavailable"));
			const now = Date.now();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "old" }],
				timestamp: now - 2000,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("old reply"),
				api: harness.session.model!.api,
				provider: harness.session.model!.provider,
				model: harness.session.model!.id,
				timestamp: now - 1000,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			for (let i = 0; i < 3; i++) await internals._runAutoCompaction("threshold", false);
			expect(summarize).toHaveBeenCalledTimes(3);

			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 900000 tokens > 200000" }),
			]);
			await harness.session.prompt("too big");

			expect(summarize).toHaveBeenCalledTimes(3);
			const outcome = harness.session.lastRunOutcome;
			expect(outcome?.status).toBe("failed");
			expect(outcome?.stopReason).toBe("error");
			expect(outcome?.errorMessage).toContain("prompt is too long");
			expect(harness.session.messages.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false);
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("three consecutive failures");
		} finally {
			harness.cleanup();
		}
	});
});
