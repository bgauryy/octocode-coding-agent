import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createExtensionRuntime, loadExtensionFromFactory } from "./helpers/features.ts";
import { ExtensionRunner } from "../src/core/features/runner.ts";
import type { ExtensionFactory } from "../src/core/features/types.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
// No lifetime to plan with: provider-managed caching with no declared `promptCache`. An Anthropic model without a declared
// `promptCache` is not unknown: its resolved tiers are the 5m and 1h the adapter sends.
const unknownModel: Model<Api> = { ...getBuiltinModel("mistral", "codestral-latest"), promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingMode;
		branch?: SessionEntry[];
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = { mode: options.mode ?? "idle", branch: options.branch ?? branchWithPrompt(100_000) };
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{
			captureUsageWriter: () => appendUsage,
			getSessionId: () => usageManager.getSessionId(),
			getBranch: () => state.branch,
		},
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, usageManager, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

afterEach(() => vi.useRealTimers());

describe("cache warming", () => {
	it("records late usage in the originating session without changing the new session", () => {
		const dir = mkdtempSync(join(tmpdir(), "warm-usage-"));
		try {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({ role: "user", content: "original", timestamp: 0 });
			const originalFile = manager.getSessionFile()!;
			const append = manager.captureUsageWriter();
			manager.newSession();
			manager.appendMessage({ role: "user", content: "new", timestamp: 1 });
			SessionManager.open(originalFile).appendMessage({ role: "user", content: "late original", timestamp: 2 });
			append("cache_warm", adaptiveModel.provider, adaptiveModel.id, warmUsage);
			expect(manager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(0);
			const resumed = SessionManager.open(originalFile);
			expect(resumed.getBranch().filter((entry) => entry.type === "usage")).toHaveLength(1);
			expect(resumed.getBranch().filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(resumed.getBranch().find((entry) => entry.type === "usage")).toMatchObject({ usage: warmUsage });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records late usage after the newest entry when the user switched away and back (A→B→A)", () => {
		const dir = mkdtempSync(join(tmpdir(), "warm-usage-"));
		try {
			const first = SessionManager.create(dir, dir);
			first.appendMessage({ role: "user", content: "original", timestamp: 0 });
			const file = first.getSessionFile()!;
			const append = first.captureUsageWriter();
			// Switching away replaces the manager; switching back opens the same file in a new one.
			first.retire();
			const reopened = SessionManager.open(file, dir);
			const newer = reopened.appendMessage({ role: "user", content: "newer", timestamp: 1 });
			const usage = append("cache_warm", adaptiveModel.provider, adaptiveModel.id, warmUsage);
			expect(usage.parentId).toBe(newer);
			const resumed = SessionManager.open(file, dir);
			expect(resumed.getBranch().map((entry) => entry.type)).toEqual(["message", "message", "usage"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains in-memory origin attribution when the active session changes", () => {
		const manager = SessionManager.inMemory();
		const parentId = manager.appendMessage({ role: "user", content: "origin", timestamp: 0 });
		const append = manager.captureUsageWriter();
		manager.newSession();
		const first = append("cache_warm", adaptiveModel.provider, adaptiveModel.id, warmUsage);
		const second = append("cache_warm", adaptiveModel.provider, adaptiveModel.id, warmUsage);
		expect(first).toMatchObject({ parentId, usage: warmUsage });
		expect(second.parentId).toBe(first.id);
		expect(manager.getEntries()).toEqual([]);
	});

	it("does not replay reasoning through Bedrock's output-budget expansion", () => {
		const bedrock = { ...budgetModel, api: "bedrock-converse-stream", provider: "amazon-bedrock" } as Model<Api>;
		expect(isReplayable(bedrock, { reasoning: "high" })).toBe(false);
		expect(isReplayable(bedrock, {})).toBe(true);
	});

	it("does not treat a large uncached tail as a reusable prefix", async () => {
		vi.useFakeTimers();
		const branch = branchWithPrompt(100);
		const message = (branch[0] as { message: AssistantMessage }).message;
		message.usage.input = 100_000;
		const runtime = fakeRuntime({ branch });
		runtime.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(runtime.calls).toHaveLength(0);
		expect(runtime.warmer.status.state).toBe("inactive");
	});

	it.each(["error", "aborted", "throw", "miss"])(
		"stops refreshing after %s until a new real request",
		async (outcome) => {
			vi.useFakeTimers();
			const runtime = fakeRuntime({
				result: async (model) => {
					if (outcome === "throw") throw new Error("offline");
					const message = response(model, outcome === "error" || outcome === "aborted" ? outcome : "length");
					return outcome === "miss"
						? { ...message, usage: { ...message.usage, cacheRead: 0, cacheWrite: 100 } }
						: message;
				},
			});
			runtime.warmer.start(request(), current);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(runtime.warmer.status.state).toBe("inactive");
			expect(runtime.appendUsage).toHaveBeenCalledTimes(outcome === "throw" ? 0 : 1);
			if (outcome === "miss") expect(formatCacheWarmingUsage(runtime.warmedEntries[0])).toContain("no hit");
			await vi.advanceTimersByTimeAsync(600_000);
			expect(runtime.calls).toHaveLength(1);
			runtime.warmer.start(request(), current);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(runtime.calls).toHaveLength(2);
			runtime.warmer.cancel();
		},
	);
	it.each([NaN, Infinity, -1, 0])("rejects invalid cache lifetime %s", (seconds) => {
		expect(getPromptCacheTtlMs({ ...adaptiveModel, promptCache: { short: seconds } }, {})).toBeUndefined();
		expect(getCacheWarmingDelayMs(seconds)).toBeUndefined();
	});

	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { OCTOCODE_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual([
			270_000,
			50_000,
			undefined,
		]);
		expect([
			isReplayable(budgetModel, { reasoning: "medium" }),
			isReplayable(budgetModel, undefined),
			isReplayable(adaptiveModel, { reasoning: "medium" }),
			isReplayable(openaiModel, { reasoning: "medium" }),
		]).toEqual([false, true, true, true]);
	});

	it("prices a miss at the long tier when the request wrote its history there", async () => {
		vi.useFakeTimers();
		const { warmer, events } = fakeRuntime();
		warmer.start(request(adaptiveModel, { cacheRetention: "long", instructionCacheRetention: "long" }), current);
		// A one-hour entry is refreshed shortly before it expires.
		await vi.advanceTimersByTimeAsync(3_570_000);
		// 100k expiring tokens rewritten at the 1-hour rate ($10/M) instead of the 5-minute rate ($6.25/M), less the read.
		expect(events[0].missCost).toBeCloseTo(0.95);
		warmer.cancel();
	});

	it("allows exactly one idle refresh for a one-hour entry, then stops at the idle limit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(adaptiveModel, { cacheRetention: "long", instructionCacheRetention: "long" }), current);
		warmer.onAgentSettled();
		expect(warmer.status.state).not.toBe("inactive");
		// The refresh lands at 90% of the hour; the 30-minute idle cap must not cut it off.
		await vi.advanceTimersByTimeAsync(3_570_000);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await vi.waitFor(() => expect(warmer.status.state).toBe("inactive"));
		expect(warmer.status).toMatchObject({ reason: expect.stringContaining("idle safety limit") });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(1);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: { reasoning: "high", sessionId: "s", transformHeaders, maxTokens: 1, maxRetries: 0 },
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
			expect.any(Number),
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it.each(["process", "request"] as const)(
		"retains the original cache tier when the %s environment changes",
		async (source) => {
			vi.useFakeTimers();
			const env = { OCTOCODE_CACHE_RETENTION: "short" };
			vi.stubEnv("OCTOCODE_CACHE_RETENTION", "short");
			const { warmer, calls } = fakeRuntime();
			try {
				warmer.start(request(adaptiveModel, source === "request" ? { env } : {}), current);
				env.OCTOCODE_CACHE_RETENTION = "long";
				vi.stubEnv("OCTOCODE_CACHE_RETENTION", "long");
				await vi.advanceTimersByTimeAsync(270_000);
				expect(calls).toHaveLength(1);
				expect(getPromptCacheTtlMs(calls[0].model, calls[0].options)).toBe(300_000);
			} finally {
				warmer.cancel();
				vi.unstubAllEnvs();
			}
		},
	);

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("recomputes the decision when an agent settles during an extension decision", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const decisions: CacheWarmingDecisionEvent[] = [];
		const { warmer, calls } = fakeRuntime({
			decide: (event) => {
				decisions.push(event);
				if (decisions.length === 1) {
					return new Promise((resolve) => {
						release = () => resolve(event.action);
					});
				}
				return event.action;
			},
		});
		warmer.start(request(), current);
		const pending = vi.advanceTimersByTimeAsync(270_000);
		await vi.waitFor(() => expect(decisions).toHaveLength(1));
		expect(decisions[0].action).toBe("warm");
		warmer.onAgentSettled();
		expect(warmer.status.decision).toMatchObject({ phase: "idle", action: "stop" });
		release();
		await pending;
		await vi.waitFor(() => expect(warmer.status.state).not.toBe("refreshing"));
		expect(decisions.map((event) => event.continuationProbability)).toEqual([1, 0.15]);
		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
	});

	it("schedules the next refresh from request dispatch rather than a slow response", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let release!: () => void;
		let requests = 0;
		const { warmer, calls, warmedEntries } = fakeRuntime({
			result: (model) => {
				requests++;
				if (requests === 1) {
					return new Promise((resolve) => {
						release = () => resolve(response(model));
					});
				}
				return Promise.resolve(response(model));
			},
		});
		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(40_000);
		release();
		await vi.waitFor(() => expect(warmer.status.state).toBe("scheduled"));
		expect(warmer.status.nextWarmAt).toBe(540_000);
		expect(warmedEntries[0]).toMatchObject({
			cacheRequestedAt: new Date(270_000).toISOString(),
		});
		expect(Date.parse(warmedEntries[0].timestamp)).toBeGreaterThanOrEqual(310_000);
		warmer.cancel();
	});

	it("bounds a long streaming turn to thirteen five-minute-cache refreshes in one hour", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls, usageManager } = fakeRuntime({ mode: "streaming" });
		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(13);
		expect(calls.every((call) => call.options?.maxTokens === 1 && call.options.maxRetries === 0)).toBe(true);
		expect(usageManager.getEntries()).toHaveLength(13);
		expect(usageManager.getEntries().every((entry) => entry.type === "usage" && entry.kind === "cache_warm")).toBe(
			true,
		);
		expect(
			usageManager
				.getEntries()
				.reduce((cost, entry) => cost + (entry.type === "usage" ? entry.usage.cost.total : 0), 0),
		).toBeCloseTo(0.13);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "one-hour safety limit reached" });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(13);
	});

	it("cancels a delayed decision at compaction and replaces an in-flight refresh on model switch", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let releaseDecision!: () => void;
		let releaseResponse!: () => void;
		let decisions = 0;
		let responses = 0;
		const runtime = fakeRuntime({
			mode: "streaming",
			decide: (event) => {
				if (++decisions === 1) {
					return new Promise((resolve) => {
						releaseDecision = () => resolve(event.action);
					});
				}
				return "warm";
			},
			result: (model) => {
				if (++responses === 1) {
					return new Promise((resolve) => {
						releaseResponse = () => resolve(response(model));
					});
				}
				return Promise.resolve(response(model));
			},
		});
		const userId = runtime.usageManager.appendMessage({ role: "user", content: "large turn", timestamp: 0 });
		runtime.usageManager.appendMessage({
			...response(adaptiveModel),
			usage: { ...warmUsage, cacheRead: 100_000, totalTokens: 100_001 },
		});
		runtime.state.branch = runtime.usageManager.getBranch();
		runtime.warmer.start(request(), current);
		const pending = vi.advanceTimersByTimeAsync(270_000);
		await vi.waitFor(() => expect(decisions).toBe(1));
		// Manual compaction cancels warming before committing a new context.
		runtime.warmer.cancel();
		runtime.usageManager.appendCompaction("summary", userId, 100_000);
		runtime.state.branch = runtime.usageManager.getBranch();
		releaseDecision();
		await pending;
		expect(runtime.calls).toHaveLength(0);

		runtime.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(runtime.calls).toHaveLength(1);
		runtime.usageManager.appendModelChange(openaiModel.provider, openaiModel.id);
		runtime.state.branch = runtime.usageManager.getBranch();
		runtime.warmer.start(request(openaiModel), current);
		expect(runtime.calls[0].options?.signal?.aborted).toBe(true);
		releaseResponse();
		await vi.waitFor(() => expect(runtime.appendUsage).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(270_000);
		expect(runtime.calls).toHaveLength(2);
		expect(runtime.calls[1].model).toBe(openaiModel);
		expect(runtime.warmedEntries.map((entry) => entry.model)).toEqual([adaptiveModel.id, openaiModel.id]);
		expect(
			runtime.warmedEntries.every(
				(entry) =>
					entry.cacheRequestedAt !== undefined && Date.parse(entry.cacheRequestedAt) <= Date.parse(entry.timestamp),
			),
		).toBe(true);
		expect(runtime.warmedEntries.reduce((cost, entry) => cost + entry.usage.cost.total, 0)).toBeCloseTo(0.02);
		runtime.warmer.cancel();
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current);
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current);
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		unsupported.warmer.start(request(unknownModel), current);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		unsupported.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current);
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and records returned usage independently of completion", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		pending.warmer.start(request(), current);
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);
		expect(pending.appendUsage).toHaveBeenCalledTimes(1);

		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).toHaveBeenCalledTimes(1);
		failed.warmer.cancel();
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry)).toBe("Cache warmed (extension override): $0.029497");
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(api) => {
				api.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(api) => {
				api.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});
