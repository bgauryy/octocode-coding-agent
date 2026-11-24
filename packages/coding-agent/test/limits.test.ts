import { describe, expect, it } from "vitest";
import { compactionThresholdTokens, inputRoomTokens } from "../src/core/compaction/settings.ts";
import { shouldCompact } from "../src/core/compaction/compaction.ts";
import { limitsProblems, resolveLimits } from "../src/core/limits.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const manager = (global: object, project: object = {}) => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	storage.withLock("project", () => JSON.stringify(project));
	return SettingsManager.fromStorage(storage, { projectTrusted: true });
};

describe("limits resolution", () => {
	it("leaves every value to the built-in when nothing is set", () => {
		expect(resolveLimits(undefined, "p/m")).toEqual({ compaction: {}, clearing: {}, run: {}, subagent: {}, cost: {} });
	});

	it("applies the model's entries over the base: patterns by length, then the exact key", () => {
		const limits = {
			compaction: { trigger: 0.9, keepRecent: 0.1 },
			clearing: { keepTurns: 10 },
			models: {
				"ollama/*": { compaction: { trigger: 0.7 }, clearing: { keepTurns: 4 } },
				"ollama/qwen*": { clearing: { keepTurns: 6 } },
				"ollama/qwen3": { compaction: { trigger: 0.5 } },
			},
		};
		expect(resolveLimits(limits, "ollama/qwen3")).toMatchObject({
			compaction: { trigger: 0.5, keepRecent: 0.1 },
			clearing: { keepTurns: 6 },
		});
		expect(resolveLimits(limits, "ollama/llama4")).toMatchObject({
			compaction: { trigger: 0.7, keepRecent: 0.1 },
			clearing: { keepTurns: 4 },
		});
		expect(resolveLimits(limits, "anthropic/claude")).toMatchObject({
			compaction: { trigger: 0.9 },
			clearing: { keepTurns: 10 },
		});
		expect(resolveLimits(limits)).toMatchObject({ compaction: { trigger: 0.9 } });
	});

	it("skips an invalid value alone and names it", () => {
		const limits = {
			compaction: { trigger: 0.05, keepRecent: 0.5 },
			clearing: { keepTurns: 0, keepInUseTokens: 5000 },
			loop: { noteAt: 6 },
			cost: { max: -1 },
			nope: 1,
			models: { "p/m": { run: { maxRequests: 1.5 }, cost: { max: 1 } } },
		};
		const resolved = resolveLimits(limits, "p/m");
		expect(resolved.compaction).toEqual({});
		expect(resolved.clearing).toEqual({ keepInUseTokens: 5000 });
		expect(resolved.loop).toBeUndefined();
		expect(resolved.run).toEqual({});
		expect(resolved.cost).toEqual({});
		const problems = limitsProblems(limits).join("\n");
		for (const key of [
			"limits.compaction.trigger",
			"limits.compaction.keepRecent",
			"limits.clearing.keepTurns",
			"limits.loop",
			"limits.cost.max",
			"limits.nope",
			"limits.models.p/m.run.maxRequests",
			"limits.models.p/m.cost",
		])
			expect(problems).toContain(`"${key}"`);
		expect(limitsProblems({ compaction: { trigger: 0.8 }, loop: { noteAt: 2, stopAt: 4, haltAt: 6 } })).toEqual([]);
	});

	it("completes a partial loop block from the built-in counts", () => {
		expect(resolveLimits({ loop: { haltAt: 12 } }).loop).toEqual({ noteAt: 3, stopAt: 5, haltAt: 12 });
	});
});

describe("limits in settings", () => {
	it("reads sizes from the project and request and spend bounds from the global file only", () => {
		const settings = manager(
			{ limits: { run: { maxRequests: 50 }, cost: { max: 5 }, clearing: { keepTurns: 8 } } },
			{
				limits: {
					run: { maxRequests: 9999 },
					subagent: { maxRequests: 0 },
					cost: { max: 500 },
					clearing: { keepTurns: 3 },
					models: { "p/m": { run: { maxRequests: 7000 }, compaction: { keepRecent: 0.2 } } },
				},
			},
		);
		expect(settings.getLimits({ provider: "p", id: "m" })).toEqual({
			compaction: { keepRecent: 0.2 },
			clearing: { keepTurns: 3 },
			run: { maxRequests: 50 },
			subagent: {},
			cost: { max: 5 },
		});
		const warnings = settings
			.drainWarnings()
			.map((warning) => warning.message)
			.join("\n");
		for (const key of ["limits.run", "limits.subagent", "limits.cost", "limits.models.p/m.run"])
			expect(warnings).toContain(`"${key}"`);
	});
});

describe("compaction limits", () => {
	it("keeps a tenth of the window, at least the default and at most a quarter", () => {
		const keep = (contextWindow: number) =>
			SettingsManager.inMemory().getCompactionSettings({ provider: "p", id: "m", contextWindow }).keepRecentTokens;
		expect(keep(300_000)).toBe(30_000);
		expect(keep(200_000)).toBe(20_000);
		expect(keep(64_000)).toBe(16_000);
		expect(keep(1_000_000)).toBe(100_000);
	});

	it("takes the tail and the trigger of the model in use", () => {
		const settings = manager({
			limits: {
				compaction: { keepRecent: 40_000 },
				models: { "local/*": { compaction: { trigger: 0.5, keepRecent: 0.2 } } },
			},
		});
		const big = settings.getCompactionSettings({ provider: "anthropic", id: "big", contextWindow: 200_000 });
		expect(big.keepRecentTokens).toBe(40_000);
		expect(big).not.toHaveProperty("triggerTokens");
		const local = settings.getCompactionSettings({ provider: "local", id: "small", contextWindow: 100_000 });
		expect(local.keepRecentTokens).toBe(20_000);
		expect(local.triggerTokens).toBe(50_000);
		expect(compactionThresholdTokens(100_000, local)).toBe(50_000);
		expect(shouldCompact(50_001, 100_000, local)).toBe(true);
		expect(shouldCompact(50_000, 100_000, local)).toBe(false);
	});

	it("never compacts later than the reserve allows, nor sooner than twice the tail", () => {
		const late = manager({ limits: { compaction: { trigger: 1 } } }).getCompactionSettings({
			provider: "p",
			id: "m",
			contextWindow: 200_000,
		});
		expect(compactionThresholdTokens(200_000, late)).toBe(inputRoomTokens(200_000, late.reserveTokens));
		const early = manager({ limits: { compaction: { trigger: 0.1, keepRecent: 0.25 } } }).getCompactionSettings({
			provider: "p",
			id: "m",
			contextWindow: 200_000,
		});
		expect(early.keepRecentTokens).toBe(50_000);
		expect(early.triggerTokens).toBe(100_000);
	});
});
