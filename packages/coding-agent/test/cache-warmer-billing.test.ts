import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
} from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import { estimateInstructionPrefixTokens } from "../src/core/cache-warmer/economics.ts";
import { IdleContinuationPool } from "../src/core/cache-warmer/idle-pool.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

type Billing = "plan" | "metered";

function reply(model: Model<Api>, usage: { cacheRead: number; input: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: usage.input,
			output: 10,
			cacheRead: usage.cacheRead,
			cacheWrite: 0,
			totalTokens: usage.input + usage.cacheRead + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function warmerFor(
	model: Model<Api>,
	billing: (provider: string) => Billing,
	usage: { cacheRead: number; input: number } = { cacheRead: 100_000, input: 0 },
) {
	const branch: SessionEntry[] = [
		{ type: "message", id: "a", parentId: null, timestamp: new Date(0).toISOString(), message: reply(model, usage) },
	];
	const streamSimple = vi.fn(
		() =>
			({
				result: async () => reply(model, { cacheRead: 100_000, input: 0 }),
			}) as unknown as AssistantMessageEventStream,
	);
	const warmer = new CacheWarmer(
		{ streamSimple, getProviderBilling: billing },
		{ captureUsageWriter: () => vi.fn(), getSessionId: () => "s", getBranch: () => branch },
		() => "idle",
		undefined,
		{ pool: new IdleContinuationPool() },
	);
	return { warmer, streamSimple };
}

const start = (warmer: CacheWarmer, model: Model<Api>, options: ModelsSimpleStreamOptions = {}, system?: string) =>
	warmer.start({ model, context: normalizeContext({ systemPrompt: system, messages: [] }), options }, () => true);

afterEach(() => vi.useRealTimers());

describe("cache warming on a plan-billed provider", () => {
	// A plan pays for the request, so neither a refresh nor a miss costs the user money, while every refresh spends plan
	// quota (Copilot counts each request). The dollar gate could never pass; the warmer does not start.
	it("never refreshes a plan-billed provider (Copilot)", async () => {
		vi.useFakeTimers();
		const runtime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
		const billing = (provider: string) => runtime.getProviderBilling(provider);
		const copilot = getBuiltinModel("github-copilot", "claude-sonnet-5.5");
		expect(billing(copilot.provider)).toBe("plan");
		const { warmer, streamSimple } = warmerFor(copilot, billing);
		start(warmer, copilot);
		expect(warmer.status).toEqual({ state: "inactive", reason: "provider billed by plan" });
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(streamSimple).not.toHaveBeenCalled();

		// The same request on a metered provider is scheduled.
		const anthropic = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		expect(billing(anthropic.provider)).toBe("metered");
		const metered = warmerFor(anthropic, billing);
		start(metered.warmer, anthropic);
		expect(metered.warmer.status.state).toBe("scheduled");
		metered.warmer.cancel();
	});

	it("stops at the next refresh when the provider has become plan-billed since the request", async () => {
		vi.useFakeTimers();
		let billing: Billing = "metered";
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const { warmer, streamSimple } = warmerFor(model, () => billing);
		start(warmer, model);
		expect(warmer.status.state).toBe("scheduled");
		billing = "plan";
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(streamSimple).not.toHaveBeenCalled();
		expect(warmer.status).toEqual({ state: "inactive", reason: "provider billed by plan" });
	});
});

describe("cache warming economics", () => {
	// Rates per MTok above 100k prompt tokens are 5x the base: the tier is picked by the whole request's prompt size.
	const tiered: Model<Api> = {
		...getBuiltinModel("anthropic", "claude-opus-4-6"),
		promptCache: { short: 300, long: 3600 },
		cost: {
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			tiers: [{ inputTokensAbove: 100_000, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
		},
	};
	// The last request: 90k cached prompt and a 20k uncached tail, 110k in all, above the tier.
	const last = { cacheRead: 90_000, input: 20_000 };

	it("prices a miss as the difference of whole-request prices, at the tier of the full request", () => {
		const { warmer } = warmerFor(tiered, () => "metered", last);
		start(warmer, tiered);
		const decision = warmer.status.decision!;
		// Miss: 110k written at 6.25 = 0.6875; hit: 90k read at 0.5 + 20k written at 6.25 = 0.17.
		expect(decision.missCost).toBeCloseTo(0.5175, 9);
		// The refresh is the hit request with a one-token reply.
		expect(decision.warmCost).toBeCloseTo(0.17, 4);
		expect(decision.action).toBe("warm");
		warmer.cancel();
	});

	it("subtracts the instruction prefix read from its own entry, still at the full request's tier", () => {
		const { warmer } = warmerFor(tiered, () => "metered", last);
		const system = "Stable instructions. ".repeat(2_000);
		start(warmer, tiered, { cacheRetention: "short", instructionCacheRetention: "long" }, system);
		const instructions = estimateInstructionPrefixTokens(
			normalizeContext({ systemPrompt: system, messages: [] }),
			tiered,
		);
		expect(instructions).toBeGreaterThan(0);
		// Only the expiring history moves from a read (0.5) to a write (6.25).
		expect(warmer.status.decision!.missCost).toBeCloseTo(((90_000 - instructions) * (6.25 - 0.5)) / 1e6, 9);
		warmer.cancel();
	});
});
