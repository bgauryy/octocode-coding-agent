import type { Api, Model, ModelThinkingLevel, TranscriptContext } from "@octocodeai/octocode-ai";
import { clampMaxTokensToContext } from "@octocodeai/octocode-ai/api/simple-options";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { describe, expect, it } from "vitest";
import { builtInCompactionSettings, thinkingBudgetTokens } from "../src/core/compaction/settings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { autoCompactAt, reserveTokensFor } from "../src/octocode/shared/tokens.ts";

const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const reserve = (contextWindow: number, level: ModelThinkingLevel, model: object = {}) =>
	builtInCompactionSettings({ contextWindow, ...model }, { level }).reserveTokens;

describe("thinking-sized compaction reserve", () => {
	// The rule these rows pin: reserve = max(today, min(max(budget + 8192 + 4096, summary room), window / 6)), where the
	// summary room (24,576) applies only to windows whose sixth can hold an inline summary.
	it.each([
		[200_000, "off", 24_576],
		[200_000, "low", 24_576],
		[130_000, "off", 21_666],
		[200_000, "medium", 24_576],
		[200_000, "high", 28_672],
		[128_000, "high", 21_333],
		[1_000_000, "high", 28_672],
		[32_000, "high", 5_333],
	] as const)("window %i at %s reserves %i", (window, level, expected) => {
		expect(reserve(window, level)).toBe(expected);
		expect(autoCompactAt({ provider: "p", id: "m", contextWindow: window }, { level })).toBe(window - expected);
	});

	it("keeps today's policy when no thinking setup is given or the window is unknown", () => {
		const model = { contextWindow: 200_000 };
		expect(builtInCompactionSettings(model).reserveTokens).toBe(24_576);
		expect(builtInCompactionSettings(model, undefined).keepRecentTokens).toBe(20_000);
		for (const contextWindow of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY * -1])
			expect(builtInCompactionSettings({ contextWindow }, { level: "high" })).toEqual({
				enabled: true,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			});
	});

	it("never reserves less than today's value and never more than a sixth of the window beyond it", () => {
		const windows = [1, 2, 7, 1000, 4096, 8192, 16_000, 32_000, 65_536, 100_000, 128_000, 200_000, 400_000, 1_000_000];
		for (const contextWindow of windows) {
			const today = builtInCompactionSettings({ contextWindow }).reserveTokens;
			for (const level of LEVELS)
				for (const compat of [undefined, { forceAdaptiveThinking: true }]) {
					const got = reserve(contextWindow, level, { compat });
					expect(got).toBeGreaterThanOrEqual(today);
					expect(got).toBeLessThanOrEqual(Math.max(today, Math.floor(contextWindow / 6)));
					// keepRecentTokens does not depend on thinking.
					expect(builtInCompactionSettings({ contextWindow }, { level }).keepRecentTokens).toBe(
						builtInCompactionSettings({ contextWindow }).keepRecentTokens,
					);
				}
		}
	});

	it("grows with the thinking level", () => {
		const sizes = (["off", "low", "medium", "high"] as const).map((level) => reserve(1_000_000, level));
		expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
		expect(sizes[3]).toBeGreaterThan(sizes[0]);
	});

	it("takes the session's custom thinking budgets", () => {
		const budgets = { high: 32_768 };
		expect(builtInCompactionSettings({ contextWindow: 1_000_000 }, { level: "high", budgets }).reserveTokens).toBe(
			32_768 + 8192 + 4096,
		);
		// A budget for another level does not affect this one.
		expect(builtInCompactionSettings({ contextWindow: 1_000_000 }, { level: "low", budgets }).reserveTokens).toBe(
			24_576,
		);
		expect(thinkingBudgetTokens({}, { level: "high", budgets: { high: Number.NaN } })).toBe(0);
	});

	it("budgets adaptive-thinking models at the high budget whenever thinking is on", () => {
		const adaptive = { compat: { forceAdaptiveThinking: true } };
		expect(thinkingBudgetTokens(adaptive, { level: "low" })).toBe(16_384);
		expect(thinkingBudgetTokens(adaptive, { level: "off" })).toBe(0);
		expect(reserve(200_000, "low", adaptive)).toBe(28_672);
	});

	it("reserves no thinking for a model without reasoning or an unknown level", () => {
		expect(thinkingBudgetTokens({ reasoning: false }, { level: "high" })).toBe(0);
		expect(thinkingBudgetTokens({}, {})).toBe(0);
		expect(thinkingBudgetTokens({}, undefined)).toBe(0);
	});

	it("is what the session's settings manager reports, with its custom budgets", () => {
		const manager = SettingsManager.inMemory({ thinkingBudgets: { high: 24_000 } });
		const model = { provider: "p", id: "m", contextWindow: 1_000_000 };
		expect(manager.getCompactionSettings(model).reserveTokens).toBe(24_576);
		expect(manager.getCompactionReserveTokens(model, "high")).toBe(24_000 + 8192 + 4096);
		expect(manager.getCompactionSettings(model, "high").keepRecentTokens).toBe(
			manager.getCompactionKeepRecentTokens(model),
		);
		expect(reserveTokensFor(model, { level: "medium" })).toBe(24_576);
	});

	// The request's output ceiling is `window - context - 4096`; at the trigger point it must still hold the thinking
	// budget and answer room.
	it.each([
		[200_000, "high"],
		[200_000, "medium"],
		[1_000_000, "high"],
	] as const)("leaves the thinking budget and answer room at the trigger for %i at %s", (window, level) => {
		const reserveTokens = reserve(window, level);
		const contextTokens = window - reserveTokens;
		const model = { provider: "p", id: "m", contextWindow: window, maxTokens: 64_000 } as Model<Api>;
		// A context the shared estimator (which both the compaction trigger and the request clamp use) counts as exactly
		// `contextTokens`.
		const context = {
			messages: [{ role: "user", content: "x".repeat(contextTokens * CHARS_PER_TOKEN), timestamp: 0 }],
		};
		const clamp = clampMaxTokensToContext(model, context as unknown as TranscriptContext, model.maxTokens);
		expect(clamp).toBeGreaterThanOrEqual(thinkingBudgetTokens({}, { level }) + 8192);
	});

	it("caps the reserve at a sixth of the window, so a 128k window cannot hold the whole budget (the adapter fits it)", () => {
		expect(reserve(128_000, "high") - 4096).toBeLessThan(thinkingBudgetTokens({}, { level: "high" }) + 8192);
		expect(reserve(128_000, "high")).toBe(Math.floor(128_000 / 6));
	});

	it("shows why the old reserve was too small: 200k at high left less than the budget", () => {
		const today = 16_384;
		expect(today - 4096).toBeLessThan(thinkingBudgetTokens({}, { level: "high" }));
	});
});
