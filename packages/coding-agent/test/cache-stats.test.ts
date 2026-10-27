import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import {
	cacheMissLabel,
	collectCacheMisses,
	computeCacheWaste,
	computeCacheMetrics,
	detectCacheMiss,
	type ModelPriceSource,
} from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const models: ModelPriceSource = {
	// $/million tokens; used as cache-read price fallback on full-miss turns
	getModel: () => ({ cost: { cacheRead: 0.3 } }),
};

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	model?: string;
	timestamp?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: options.model ?? "test-model",
		usage: {
			input: options.input ?? 0,
			output: 10,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { ...zeroCost, ...options.cost },
		},
		stopReason: "stop",
		timestamp: options.timestamp ?? 0,
	};
}

function entry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: "x", parentId: null, timestamp: "", message };
}

function usageEntry(kind: string, timestamp: number): SessionEntry {
	return {
		type: "usage",
		id: `usage-${kind}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		kind,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 100_000,
			cost: zeroCost,
		},
	};
}

// Turn 1: fresh 100k cache write at $3.75/M
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
// Turn 2: healthy, everything read back at $0.30/M
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates missed tokens and cost across turns", () => {
		// Turn 3: full miss, previous 105k prompt re-billed at $3.75/M write
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(turn3)], models);
		expect(totals.missedTokens).toBe(105_000);
		// 105k at ($3.75 - $0.30)/M
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste([entry(turn1), entry(turn2)], models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it("skips the turn after a compaction reset", () => {
		const reset = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;
		const afterReset = assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } });
		const totals = computeCacheWaste([entry(turn1), reset, entry(afterReset)], models);
		expect(totals.missedTokens).toBe(0);
	});

	it("counts misses caused by model switches", () => {
		const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" });
		const totals = computeCacheWaste([entry(turn1), entry(otherModel)], models);
		expect(totals.missedTokens).toBe(100_000);
		expect(totals.missCount).toBe(1);
	});

	it("skips providers that report no cache activity", () => {
		const a = assistant({ input: 100_000 });
		const b = assistant({ input: 110_000 });
		const totals = computeCacheWaste([entry(a), entry(b)], models);
		expect(totals.missedTokens).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps counted misses to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses([entry(turn1), entry(turn2), entry(missTurn)], models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("detects a miss on a just-completed message with idle time", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missMessage, models);
		expect(miss).toBeDefined();
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		// 600s - 60s since the previous request
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
	});

	it("flags model switches on detected misses", () => {
		const otherModel = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
	});

	it("uses only cache-warm usage entries as cache refreshes", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });

		const afterCacheWarm = detectCacheMiss([entry(turn1), usageEntry("cache_warm", 500_000)], missMessage, models);
		const afterOtherUsage = detectCacheMiss(
			[entry(turn1), usageEntry("custom_operation", 500_000)],
			missMessage,
			models,
		);

		expect(afterCacheWarm?.idleMs).toBe(100_000);
		expect(afterOtherUsage?.idleMs).toBe(600_000);
	});

	it("returns undefined for healthy turns", () => {
		const healthy = assistant({
			cacheRead: 105_000,
			cacheWrite: 2_000,
			cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], healthy, models)).toBeUndefined();
	});

	it("returns undefined for the first turn of a session", () => {
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});
});

describe("measured cache usage by purpose", () => {
	it("does not inflate conversation hits with warming, summaries or tool usage", () => {
		const usage = assistant({ cacheRead: 900, input: 100, cost: { total: 0.2 } }).usage;
		const base = { id: "x", parentId: null, timestamp: "" };
		const entries = [
			entry(assistant({ input: 100 })),
			entry(assistant({ cacheRead: 50, input: 50 })),
			{ ...base, type: "usage", kind: "cache_warm", provider: "p", model: "m", usage },
			{ ...base, type: "compaction", usage },
			{ ...base, type: "branch_summary", usage },
			{ ...base, type: "message", message: { role: "toolResult", usage } },
			{ ...base, type: "usage", kind: "other", usage },
		] as SessionEntry[];
		const stats = computeCacheMetrics(entries);
		expect(stats.conversation).toMatchObject({ requests: 2, promptTokens: 200, cacheRead: 50, hitRate: 0.25 });
		for (const purpose of ["warming", "compaction", "branchSummary", "tools", "other"] as const) {
			expect(stats[purpose]).toMatchObject({ requests: 1, promptTokens: 1000, hitRate: 0.9, cost: 0.2 });
		}
	});
	it("reports unknown for no input, and zero for a measured cold request", () => {
		expect(computeCacheMetrics([]).conversation.hitRate).toBeNull();
		expect(computeCacheMetrics([entry(assistant({ input: 100 }))]).conversation.hitRate).toBe(0);
	});
});

describe("cache miss areas", () => {
	const systemEntry = {
		type: "message",
		id: "s",
		parentId: null,
		timestamp: "",
		message: { role: "system", content: "", toolsAdded: [{ name: "web" }], timestamp: 90_000 },
	} as SessionEntry;
	const missTurn = (fields: { cacheRead?: number; cacheWrite: number }) =>
		assistant({ ...fields, cost: { cacheWrite: fields.cacheWrite * 3.75e-6 }, timestamp: 600_000 });

	it("attributes a miss that still read the cached prefix to the history", () => {
		const miss = detectCacheMiss(
			[entry(turn1), entry(turn2)],
			missTurn({ cacheRead: 20_000, cacheWrite: 90_000 }),
			models,
		);
		expect(miss).toMatchObject({ missedTokens: 85_000, fullMiss: false, promptChanged: false });
	});

	it("marks a miss that read nothing from the cache as full", () => {
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missTurn({ cacheWrite: 110_000 }), models);
		expect(miss).toMatchObject({ fullMiss: true, promptChanged: false });
	});

	it("notes an instruction or tool update since the previous request", () => {
		const entries = [entry(turn1), entry(turn2), systemEntry];
		expect(detectCacheMiss(entries, missTurn({ cacheWrite: 110_000 }), models)?.promptChanged).toBe(true);
		// The update is attributed once: the request after the next one compares against that next one.
		const next = assistant({ cacheRead: 110_000, cacheWrite: 0, timestamp: 620_000 });
		const later = assistant({ cacheWrite: 120_000, cost: { cacheWrite: 0.45 }, timestamp: 640_000 });
		const misses = collectCacheMisses([...entries, entry(next), entry(later)], models);
		expect(misses.get(later)?.promptChanged).toBe(false);
	});

	it("compares the concrete model a cache refresh reported with the concrete model of the next reply", () => {
		// Providers report a dated snapshot for an alias; the refresh records it, so the reply must be keyed the same way.
		const aliased = (message: AssistantMessage) => ({ ...message, responseModel: "test-model-20260101" });
		const warm = { ...usageEntry("cache_warm", 500_000), model: "test-model-20260101" } as SessionEntry;
		const miss = detectCacheMiss([entry(aliased(turn1)), warm], aliased(missTurn({ cacheWrite: 110_000 })), models);
		expect(miss?.modelChanged).toBe(false);
	});
});

describe("cacheMissLabel", () => {
	const miss = {
		missedTokens: 50_000,
		missedCost: 0.2,
		idleMs: 10 * 60_000,
		modelChanged: false,
		fullMiss: false,
		promptChanged: false,
	};

	it("names an idle gap only when it outlasted the cache lifetime", () => {
		expect(cacheMissLabel(miss)).toBe("History cache miss");
		expect(cacheMissLabel(miss, 5 * 60_000)).toBe("History cache miss after 10m idle");
		// A 1-hour entry outlives a 10-minute gap, so the gap does not explain the miss.
		expect(cacheMissLabel(miss, 60 * 60_000)).toBe("History cache miss");
	});

	it("says whether the instructions were re-billed too", () => {
		expect(cacheMissLabel({ ...miss, fullMiss: true })).toBe("Full cache miss");
		expect(cacheMissLabel({ ...miss, fullMiss: true }, 60 * 60_000)).toBe("Full cache miss");
	});

	it("reports the provider's own reason ahead of any inferred cause", () => {
		const reported = { ...miss, apiReason: "tools_changed", modelChanged: true, promptChanged: true };
		expect(cacheMissLabel(reported, 5 * 60_000)).toBe("History cache miss: provider reports tools changed");
		expect(cacheMissLabel({ ...reported, fullMiss: true })).toBe("Full cache miss: provider reports tools changed");
	});

	it("reads the reason from the cache_miss diagnostic on the reply", () => {
		const previous = assistant({ cacheRead: 90_000, cacheWrite: 1_000, timestamp: 1_000 });
		const missed = assistant({ cacheWrite: 92_000, cost: { cacheWrite: 0.345 }, timestamp: 2_000 });
		const reported = {
			...missed,
			diagnostics: [
				{ type: "cache_miss", timestamp: 2_000, details: { reason: "system_changed", missedInputTokens: 90_000 } },
			],
		};
		expect(detectCacheMiss([entry(previous)], reported, models)?.apiReason).toBe("system_changed");
		expect(detectCacheMiss([entry(previous)], missed, models)?.apiReason).toBeUndefined();
	});

	it("names a model switch first, then an instruction or tool update", () => {
		expect(cacheMissLabel({ ...miss, modelChanged: true, promptChanged: true }, 60 * 60_000)).toBe(
			"Cache miss after model switch",
		);
		expect(cacheMissLabel({ ...miss, promptChanged: true })).toBe("Cache miss after instruction or tool update");
	});
});
