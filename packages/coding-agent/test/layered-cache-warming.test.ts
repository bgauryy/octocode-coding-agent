import { type AssistantMessageEventStream, type Model, normalizeContext, type Usage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer, getPromptCacheLifetime, getPromptCacheTtlMs } from "../src/core/cache-warmer.ts";
import { estimateInstructionPrefixTokens } from "../src/core/cache-warmer/economics.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test",
	name: "Test",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	promptCache: { short: 300, long: 3600 },
};
const layered = { cacheRetention: "short", instructionCacheRetention: "long" } as const;

function branch(cacheRead: number): SessionEntry[] {
	const usage: Usage = {
		input: 0,
		output: 10,
		cacheRead,
		cacheWrite: 0,
		totalTokens: cacheRead + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "stop",
				timestamp: 0,
			},
		},
	];
}

function warmer(cacheRead: number) {
	return new CacheWarmer(
		{
			streamSimple: () => ({ result: async () => undefined }) as unknown as AssistantMessageEventStream,
			getProviderBilling: () => "metered",
		},
		{ captureUsageWriter: () => vi.fn(), getSessionId: () => "s", getBranch: () => branch(cacheRead) },
		() => "streaming",
	);
}

afterEach(() => vi.useRealTimers());

describe("layered cache warming", () => {
	it("refreshes on the history lifetime, which expires before the instruction entry", () => {
		expect(getPromptCacheLifetime(model, layered)).toEqual({ ttlMs: 300_000, layered: true, history: "short" });
		expect(getPromptCacheTtlMs(model, layered)).toBe(300_000);
	});
	it("treats the pair as one lifetime when the endpoint cannot write long entries", () => {
		const shortOnly = { ...model, compat: { supportsLongCacheRetention: false } };
		expect(getPromptCacheLifetime(shortOnly, layered)).toEqual({ ttlMs: 300_000, layered: false, history: "short" });
	});
	it("plans with the 1h instruction entry the adapter writes when the model declares only its short lifetime", () => {
		expect(getPromptCacheLifetime({ ...model, promptCache: { short: 300 } }, layered)).toEqual({
			ttlMs: 300_000,
			layered: true,
			history: "short",
		});
	});
	it("keeps single-lifetime warming and honors explicit disabling", () => {
		expect(getPromptCacheLifetime(model, { cacheRetention: "long" })).toEqual({
			ttlMs: 3600000,
			layered: false,
			history: "long",
		});
		expect(getPromptCacheTtlMs(model, { cacheRetention: "none", instructionCacheRetention: "long" })).toBeUndefined();
		expect(getPromptCacheTtlMs(model, { env: { OCTOCODE_CACHE_RETENTION: "none" } })).toBeUndefined();
		expect(getPromptCacheTtlMs(model, { cacheRetention: "short", instructionCacheRetention: "none" })).toBe(300_000);
		// Adapters send long history behind short instructions at 5m, so that is the entry to keep.
		expect(getPromptCacheTtlMs(model, { cacheRetention: "long", instructionCacheRetention: "short" })).toBe(300_000);
	});
	it("prices a miss as the history alone, since the instruction prefix outlives it", () => {
		const systemPrompt = "x".repeat(30_000);
		const context = normalizeContext({ systemPrompt, messages: [] });
		// Without a model: the densest family's 2.5 characters per token.
		const instructionTokens = estimateInstructionPrefixTokens(context);
		expect(instructionTokens).toBe(12_000);

		vi.useFakeTimers();
		const single = warmer(100_000);
		single.start({ model, context, options: { cacheRetention: "short" } }, () => true);
		const split = warmer(100_000);
		split.start({ model, context, options: layered }, () => true);
		const singleMiss = single.status.decision?.missCost ?? 0;
		const splitMiss = split.status.decision?.missCost ?? 0;
		expect(split.status.state).toBe("scheduled");
		expect(splitMiss).toBeCloseTo((singleMiss * (100_000 - instructionTokens)) / 100_000, 10);
		single.cancel();
		split.cancel();
	});
	it("stops when only the long-lived instruction prefix is cached", () => {
		vi.useFakeTimers();
		const context = normalizeContext({ systemPrompt: "x".repeat(30_000), messages: [] });
		const onlyInstructions = warmer(10_000);
		onlyInstructions.start({ model, context, options: layered }, () => true);
		expect(onlyInstructions.status.decision).toMatchObject({ missCost: 0, economicsAvailable: true, action: "stop" });
		onlyInstructions.cancel();
	});
});
