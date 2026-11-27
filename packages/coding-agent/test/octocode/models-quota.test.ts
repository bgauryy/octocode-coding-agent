import type { QuotaReading } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { MODELS_DEV_ENV } from "../../src/core/model-catalog/index-store.ts";
import { ProviderQuotas, providerQuotas, type QuotaStore } from "../../src/core/model-runtime/quota-request.ts";
import { registerModelsTool } from "../../src/octocode/native/tools/models/tool.ts";
import type { ModelRef } from "../../src/octocode/subagents/model.ts";
import { providerState, sessionSpend } from "../../src/octocode/subagents/models-quota.ts";
import { QUOTA_NOTICE_ID, QuotaWatch } from "../../src/octocode/subagents/models-quota-notice.ts";
import { fakeHost, meteredBilling } from "./fake-host.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const HOUR = 3_600_000;

const emptyStore = (): QuotaStore => ({ read: () => [], readSince: () => [], write: async () => {} });

const window = (provider: string, usedFraction: number, resetsAt: number | undefined, at = NOW): QuotaReading => ({
	provider,
	window: "primary",
	label: "5h",
	usedFraction,
	...(resetsAt !== undefined ? { resetsAt } : {}),
	kind: "plan",
	source: "header",
	observedAt: at,
});

const reply = (provider: string, cost: number, billing?: "plan" | "metered") =>
	({
		type: "message",
		id: `${provider}-${cost}`,
		parentId: null,
		timestamp: "2026-11-23T12:00:00.000Z",
		...(billing ? { billing } : {}),
		message: {
			role: "assistant",
			provider,
			model: "m",
			content: [],
			stopReason: "stop",
			timestamp: NOW,
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
		},
	}) as never;

const registry = (models: ModelRef[], extra: Record<string, unknown> = {}) => ({
	...meteredBilling,
	getAvailable: () => models,
	getAll: () => models,
	find: () => undefined,
	getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
	...extra,
});

const none = { cooldowns: { remainingMs: () => 0 }, refused: () => false, catalog: () => ({ source: "off" }) as never };

beforeEach(() => vi.stubEnv("TZ", "UTC"));
afterEach(() => vi.unstubAllEnvs());

describe("the models tool's provider state", () => {
	it("lists each provider's plan windows, health and this session's spend, money apart from plan", () => {
		const quotas = new ProviderQuotas(emptyStore, () => NOW);
		quotas.record([window("codex", 0.92, NOW + 2 * HOUR + 20 * 60_000)]);
		const models: ModelRef[] = [
			{ provider: "codex", id: "gpt" },
			{ provider: "anthropic", id: "old" },
			{ provider: "anthropic", id: "new" },
			{ provider: "quiet", id: "q" },
		];
		const text = providerState(
			{
				model: models[0] as never,
				modelRegistry: registry(models, {
					getProviderBilling: (provider: string) => (provider === "codex" ? "plan" : "metered"),
					isModelDeprecated: (model: ModelRef) => model.id === "old",
				}) as never,
				sessionManager: { getEntries: () => [reply("codex", 3.1), reply("anthropic", 1.24)] } as never,
			},
			models,
			undefined,
			{
				quotas,
				cooldowns: { remainingMs: (provider) => (provider === "anthropic" ? 42_000 : 0) },
				refused: () => false,
				catalog: () => ({ fetchedAt: NOW, source: "cache", stale: true, inert: "the setting is off" }),
			},
		);
		expect(text.split("\n")).toEqual([
			"Provider state (plan quota windows, health, this session's spend):",
			"  codex (this session): 5h 92% (resets 14:20) · spent ~$3.10 plan",
			"  anthropic: cooling down 42s (rate limit) · deprecated old · spent ≈$1.24",
			"This session spent ≈$1.24 · ~$3.10 plan (replies, summaries and subagents; plan at list price).",
			"Catalog: index stale; updates inert: the setting is off.",
		]);
	});

	it("narrows to one provider, names a refusal by kind, and says nothing when nothing is known", () => {
		const quotas = new ProviderQuotas(emptyStore, () => NOW);
		const models: ModelRef[] = [
			{ provider: "a", id: "x" },
			{ provider: "b", id: "y" },
		];
		const ctx = {
			model: models[0] as never,
			modelRegistry: registry(models) as never,
			sessionManager: { getEntries: () => [] } as never,
		};
		expect(providerState(ctx, models, undefined, { ...none, quotas })).toBe("");
		const refused = providerState(ctx, models, "b", { ...none, quotas, refused: (provider) => provider !== "c" });
		expect(refused.split("\n").slice(1)).toEqual(["  b: refused (usage limit)"]);
	});

	it("counts a plan-paid entry as an estimate, whatever its provider bills now (billing stored at write)", () => {
		const facts = { billingOf: () => "metered" as const, provider: "codex" };
		const { total, byProvider } = sessionSpend([reply("codex", 2, "plan"), reply("codex", 1)], facts);
		expect(total).toEqual({ money: 1, plan: 2, unpriced: false });
		expect(byProvider.get("codex")).toEqual({ money: 1, plan: 2, unpriced: false });
	});
});

describe("V15: the quota notice", () => {
	it("shows a stored 92% window in the models call, then tells the agent once for that window", async () => {
		// The process's own store, as a request's headers fill it; a provider no other test writes.
		const provider = `quota-tool-${process.pid}-${Date.now()}`;
		providerQuotas.record([window(provider, 0.92, Date.now() + 2 * HOUR, Date.now())]);
		const models: ModelRef[] = [
			{ provider, id: "plan-model", cost: { input: 1, output: 2 }, contextWindow: 200_000 },
			{ provider: "spare", id: "s", cost: { input: 1, output: 2 }, contextWindow: 200_000 },
		];
		const saved = process.env[MODELS_DEV_ENV];
		process.env[MODELS_DEV_ENV] = "0";
		// One host for the tool and its notice: the notice registers with the models tool.
		const host = fakeHost();
		registerModelsTool(host.api, () => new Map());
		const tool = host.tools.get("models") as ToolDefinition | undefined;
		const ctx = {
			model: models[0],
			modelRegistry: registry(models),
			sessionManager: { getEntries: () => [] },
		};
		try {
			const result = await tool!.execute("c", {}, undefined, undefined, ctx as never);
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			expect(text).toMatch(new RegExp(`${provider} \\(this session\\): 5h 92% \\(resets \\d\\d:\\d\\d\\)`));
		} finally {
			if (saved === undefined) delete process.env[MODELS_DEV_ENV];
			else process.env[MODELS_DEV_ENV] = saved;
		}

		const first = (await host.fire("before_agent_start", {}, ctx)) as {
			message: { customType: string; content: string };
		};
		expect(first.message.customType).toBe(QUOTA_NOTICE_ID);
		expect(first.message.content).toContain(`${provider}, this session's provider, has used 92% of its 5h plan window`);
		expect(first.message.content).toContain("not limited: spare");
		// The next turn and the next run: the same window is not told again.
		await host.fire("turn_end", {}, ctx);
		expect(host.sent).toEqual([]);
		expect(await host.fire("before_agent_start", {}, ctx)).toBeUndefined();
	});

	it("fires once per window: again for the next period, or after a session switch", () => {
		let now = NOW;
		const quotas = new ProviderQuotas(emptyStore, () => now);
		const watch = new QuotaWatch(quotas, () => false);
		const models: ModelRef[] = [{ provider: "codex", id: "gpt" }];
		const ctx = { model: models[0] as never, modelRegistry: registry(models) as never };
		quotas.record([window("codex", 0.85, NOW + HOUR)]);
		expect(watch.notice(ctx)).toBeUndefined();
		quotas.record([window("codex", 0.91, NOW + HOUR, NOW + 1)]);
		expect(watch.notice(ctx)).toContain("No other connected provider is free of limits.");
		// Rising further within the same window, its reset read a minute off: still the same window.
		quotas.record([window("codex", 0.99, NOW + HOUR + 60_000, NOW + 2)]);
		expect(watch.notice(ctx)).toBeUndefined();
		// The next period of the window.
		now = NOW + 2 * HOUR;
		quotas.record([window("codex", 0.95, NOW + 6 * HOUR, now)]);
		expect(watch.notice(ctx)).toContain("95%");
		expect(watch.notice(ctx)).toBeUndefined();
		watch.reset();
		expect(watch.notice(ctx)).toContain("95%");
	});
});
