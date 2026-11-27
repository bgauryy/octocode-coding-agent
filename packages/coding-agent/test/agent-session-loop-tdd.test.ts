import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCompactionLimit } from "../src/core/agent-session/auto-compaction-limit.ts";
import { lengthContinuationMessage } from "../src/core/agent-session/length-continuation.ts";
import { ResumeTimer } from "../src/core/agent-session/usage-limit-wait.ts";
import { testFeatures } from "./helpers/features.ts";
import { createHarness } from "./suite/harness.ts";

describe("AgentSession loop, timers, limits & abort isolation (TDD)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires ResumeTimer asynchronously even when armed at a past timestamp and cleans up listeners", async () => {
		vi.useFakeTimers();
		const listeners = new Set<unknown>();
		const statuses: Array<string | undefined> = [];
		const timer = new ResumeTimer({
			agent: {
				subscribe: (fn) => {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				},
			},
			sessionId: () => "session-1",
			status: (text) => statuses.push(text),
		});

		let fired = 0;
		timer.arm(Date.now() - 5_000, "waiting for reset", () => {
			fired++;
		});

		// Must NOT fire synchronously inside arm() while the caller's run is still unwinding!
		expect(fired).toBe(0);
		expect(timer.armed).toBe(true);
		expect(listeners.size).toBe(1);
		expect(statuses).toEqual(["waiting for reset"]);

		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toBe(1);
		expect(timer.armed).toBe(false);
		expect(listeners.size).toBe(0);
		expect(statuses).toEqual(["waiting for reset", undefined]);
	});

	it("tracks AutoCompactionLimit per model key without cross-model amnesia and uses progressive backoff", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const limit = new AutoCompactionLimit();

		for (let i = 0; i < 3; i++) {
			expect(limit.check("anthropic/claude", "threshold")).toBe("run");
			limit.failed("anthropic/claude");
		}
		expect(limit.check("anthropic/claude", "threshold")).toBe("notice");

		// Switching briefly to another model must NOT reset anthropic/claude's trip state!
		expect(limit.check("openai/gpt", "threshold")).toBe("run");
		expect(limit.check("anthropic/claude", "threshold")).toBe("quiet");

		// Progressive backoff lets a retry through after 1 minute on the first trip instead of a flat 60-minute cliff.
		vi.advanceTimersByTime(60_000);
		expect(limit.check("anthropic/claude", "threshold")).toBe("run");
		limit.failed("anthropic/claude");

		// Second consecutive trip backs off longer (5 minutes).
		vi.advanceTimersByTime(60_000);
		expect(limit.check("anthropic/claude", "threshold")).toBe("notice");
		vi.advanceTimersByTime(4 * 60_000);
		expect(limit.check("anthropic/claude", "threshold")).toBe("run");

		// Healthy response resets the key's trip state.
		limit.succeeded("anthropic/claude");
		expect(limit.check("anthropic/claude", "threshold")).toBe("run");
	});

	it("manual compaction resets the current model's failure key explicitly", async () => {
		const succeeded = vi.spyOn(AutoCompactionLimit.prototype, "succeeded");
		const h = await createHarness({
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Manual checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		try {
			h.sessionManager.appendMessage({ role: "user", content: "Keep this request", timestamp: 1 });
			h.sessionManager.appendMessage(fauxAssistantMessage("Keep this answer"));
			h.session.refreshContext();

			await h.session.compact();

			const model = h.session.model!;
			const key = JSON.stringify([h.sessionManager.getSessionId(), model.provider, model.id]);
			expect(succeeded).toHaveBeenCalledWith(key);
		} finally {
			succeeded.mockRestore();
			h.cleanup();
		}
	});

	it("continues plain non-window-constrained length stops below desiredMaxOutput and yields to pending steering", () => {
		const truncated = {
			...fauxAssistantMessage("halfway through answer", { stopReason: "length" }),
			usage: {
				input: 1_000,
				output: 4_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};

		// Output (4k) < desiredMaxOutput (16k), NOT near context window -> should still continue!
		expect(lengthContinuationMessage(truncated, 0, 16_000, { nearWindow: false })).toBeDefined();
		// Near window -> defer to post-run overflow compaction (returns undefined).
		expect(lengthContinuationMessage(truncated, 0, 16_000, { nearWindow: true })).toBeUndefined();
		// Pending user steering -> suppress synthetic "Continue" prompt so user's steer drives next turn!
		expect(
			lengthContinuationMessage(truncated, 0, 4_000, { nearWindow: false, hasPendingSteering: true }),
		).toBeUndefined();
	});

	it("does not invoke UI user-draft abortHandler on non-interrupted peer aborts", async () => {
		let toolStarted!: () => void;
		const entered = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		let releaseTool!: () => void;
		const holdTool = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let peerAbort!: () => void;
		const uiAbortHandler = vi.fn();

		const h = await createHarness({
			settings: { retry: { enabled: false } },
			tools: [
				{
					name: "wait_tool",
					label: "wait",
					description: "wait",
					parameters: Type.Object({}),
					execute: async () => {
						toolStarted();
						await holdTool;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
			features: testFeatures([
				(api) => {
					api.bus.on("tool_execution_start", (_event, ctx) => {
						peerAbort = () => ctx.abort("peer");
					});
				},
			]),
		});

		try {
			await h.session.bindFeatures({ mode: "tui", abortHandler: uiAbortHandler });
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_tool", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("handled follow-up"),
			]);

			const running = h.session.prompt("initial");
			await entered;
			await h.session.followUp("keep my follow-up");
			expect(h.session.getFollowUpMessages()).toEqual(["keep my follow-up"]);

			peerAbort();
			releaseTool();
			await running;

			expect(uiAbortHandler).not.toHaveBeenCalled();
			// Because peer abort did NOT wipe user follow-ups, the queued follow-up was preserved and answered!
			expect(JSON.stringify(h.session.messages)).toContain("keep my follow-up");
			expect(JSON.stringify(h.session.messages)).toContain("handled follow-up");
		} finally {
			releaseTool();
			h.cleanup();
		}
	});
});
