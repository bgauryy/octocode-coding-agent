import type { Api, AssistantMessage, Model, RequestLayer, RequestTrace, Usage } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { compactionCost } from "../../src/core/cache-warmer/compaction-cost.ts";
import { getPromptCacheTtlMs, idleContinuationProbability } from "../../src/core/cache-warmer/economics.ts";
import { firstChangedArea, formatLayerChange } from "../../src/core/cache-warmer/first-change.ts";
import { planRetention } from "../../src/core/cache-warmer/retention.ts";
import { turnCosts } from "../../src/core/cache-warmer/turn-costs.ts";
import { usageRecord } from "../../src/core/cache-warmer/usage-record.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { formatSessionReport } from "../../src/octocode/shared/session-report.ts";

// RFC F6's worked example: Opus 5.5 list prices per MTok.
const opus: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-5-5"),
	baseUrl: "https://api.anthropic.com",
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const gateway: Model<Api> = {
	...opus,
	baseUrl: "https://gateway.example.com",
	compat: { supportsLongCacheRetention: false },
};
const MIN = 60_000;

function usage(fields: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...fields,
	};
}

function assistant(cost: number, trace?: RequestTrace, fields: Partial<Usage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: usage({ ...fields, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
		stopReason: "stop",
		timestamp: 0,
		...(trace ? { requestTrace: trace } : {}),
	};
}

const layer = (kind: RequestLayer["kind"], hash: string, index?: number): RequestLayer => ({
	kind,
	hash,
	chars: 10,
	...(index !== undefined ? { index } : {}),
});
const trace = (...layers: RequestLayer[]): RequestTrace => ({ layers });

let id = 0;
function entry(message: AssistantMessage | { role: "user"; content: string; timestamp: number }): SessionEntry {
	id++;
	return { type: "message", id: `e${id}`, parentId: null, timestamp: "", message };
}
const user = () => entry({ role: "user", content: "go", timestamp: 0 });

describe("usage record", () => {
	it("splits writes by lifetime, OpenAI 30m beside 12h, and files the unsplit rest under the resolved short tier", () => {
		const openai = assistant(0.01, undefined, { cacheWrite: 7000, cacheWrite12h: 4000, cacheWrite30m: 3000 });
		expect(usageRecord(openai).cacheWrite.byTtl).toEqual({ "12h": 4000, "30m": 3000 });
		const record = usageRecord(assistant(0.02, undefined, { cacheWrite: 900, cacheWrite1h: 400, cacheRead: 5 }), opus);
		expect(record).toMatchObject({
			provider: "anthropic",
			transport: "changes",
			tier: { mechanism: "markers", short: "5m", long: "1h", controllable: true },
			cacheRead: 5,
			cacheWrite: { total: 900, byTtl: { "1h": 400, "5m": 500 } },
			cost: 0.02,
			lowerBound: false,
		});
		expect(usageRecord(assistant(0, undefined, { cacheWrite: 10 }), gateway).tier).toEqual({
			mechanism: "markers",
			short: "5m",
			controllable: true,
		});
	});
});

describe("first changed area", () => {
	const base = trace(
		layer("tools", "t"),
		layer("system", "s0", 0),
		layer("system", "s1", 1),
		layer("message", "m0", 0),
	);
	it("names the earliest differing layer from payload-layer hashes", () => {
		expect(firstChangedArea(undefined, base)).toEqual({ area: "cold" });
		expect(firstChangedArea(base, base)).toEqual({ area: "none" });
		const appended = trace(...base.layers, layer("message", "m1", 1));
		expect(firstChangedArea(base, appended)).toEqual({ area: "append", position: 4 });
		const system = trace(base.layers[0], base.layers[1], layer("system", "new", 1), base.layers[3]);
		const change = firstChangedArea(base, system);
		expect(change).toEqual({ area: "system", position: 2, index: 1 });
		expect(formatLayerChange(change!)).toBe("system[1]");
		expect(firstChangedArea(base, trace(layer("tools", "other"), ...base.layers.slice(1)))).toEqual({
			area: "tools",
			position: 0,
		});
		expect(firstChangedArea(base, trace(...base.layers.slice(0, 2)))).toEqual({
			area: "system",
			position: 2,
			index: 1,
		});
		expect(firstChangedArea(base, undefined)).toBeUndefined();
	});
});

describe("$/turn", () => {
	const t1 = trace(layer("system", "s0", 0), layer("message", "u1", 0));
	const t2 = trace(...t1.layers, layer("message", "a1", 1), layer("message", "r1", 2));
	const t3 = trace(layer("system", "s0-changed", 0), ...t2.layers.slice(1), layer("message", "u2", 3));
	const entries = [
		user(),
		entry(assistant(0.1, t1)),
		entry(assistant(0.02, t2)),
		user(),
		entry(assistant(0.3, t3, { lowerBound: true })),
		{
			type: "usage",
			id: "w",
			parentId: null,
			timestamp: "",
			kind: "cache_warm",
			provider: "anthropic",
			model: "m",
			usage: usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } }),
		} as SessionEntry,
	];
	it("sums each user turn's responses and refreshes and keeps its costliest first change", () => {
		const turns = turnCosts(entries);
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ turn: 1, requests: 2, lowerBound: false, firstChange: { area: "cold" } });
		expect(turns[0].cost).toBeCloseTo(0.12, 10);
		expect(turns[1]).toMatchObject({
			turn: 2,
			requests: 1,
			lowerBound: true,
			firstChange: { area: "system", index: 0 },
		});
		expect(turns[1].cost).toBeCloseTo(0.35, 10);
	});
	it("shows $/turn and the first changed area in the /session report", () => {
		const stats = {
			sessionId: "s",
			totalMessages: 5,
			userMessages: 2,
			assistantMessages: 3,
			toolCalls: 0,
			toolResults: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			thinkingReduced: 0,
			cache: { conversation: { hitRate: null, requests: 0 }, warming: { requests: 0, cost: 0 } },
			cost: 0.47,
			lowerBoundEntries: 0,
		} as unknown as Parameters<typeof formatSessionReport>[0]["stats"];
		const text = formatSessionReport({
			stats,
			entries,
			branch: entries,
			prices: { getModel: () => undefined },
			selectedModelKey: "x/y",
		});
		expect(text).toContain("$/turn: $0.2350 average over 2 turns (at least)");
		expect(text).toContain("Turn 1: $0.1200 (2 requests, first change: cold)");
		expect(text).toContain("Turn 2: $0.3500 (1 request, first change: system[0])");
	});
});

describe("retention calculator", () => {
	const span = { model: opus, prefixTokens: 100_000, turnTokens: 5_000 };
	it("prefers 5m refreshes over the 1h premium for a short gap (RFC F6 example)", () => {
		const plan = planRetention({ ...span, gapsMs: [20 * MIN] });
		expect(plan.choice).toBe("short");
		// Four refreshes at $0.02 (plus one output token each) against $0.30 once and $0.015 per turn.
		expect(plan.costs.short).toBeCloseTo(0.08 + 4 * 0.00002, 6);
		expect(plan.costs.long).toBeCloseTo(0.33, 6);
	});
	it("prefers 1h past the idle warming limit, where six refreshes are followed by a miss", () => {
		const plan = planRetention({ ...span, gapsMs: [40 * MIN] });
		expect(plan.costs.short).toBeCloseTo(0.12 + 6 * 0.00002 + 0.48, 6);
		expect(plan.choice).toBe("long");
	});
	it("never assumes a long tier the adapter does not send (a gateway host)", () => {
		const plan = planRetention({ ...span, model: gateway, gapsMs: [40 * MIN] });
		expect(plan).toMatchObject({ choice: "short", shortTtl: "5m" });
		expect(plan.costs.long).toBeUndefined();
		expect(plan.longTtl).toBeUndefined();
	});
	it("takes the longest retention where writes cost no premium (OpenAI before explicit caching)", () => {
		const free: Model<"openai-responses"> = {
			...getBuiltinModel("openai", "gpt-5"),
			baseUrl: "https://api.openai.com/v1",
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			compat: { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: true },
		};
		expect(planRetention({ ...span, model: free, gapsMs: [20 * MIN] })).toMatchObject({
			choice: "long",
			longTtl: "24h",
		});
	});
	it("leaves retention to the provider and the warmer idle where the TTL is not controllable (Gemini, xAI)", () => {
		for (const model of [getBuiltinModel("google", "gemini-2.5-pro"), getBuiltinModel("xai", "grok-4.3")]) {
			expect(planRetention({ ...span, model, gapsMs: [20 * MIN] }).choice).toBe("provider");
			expect(getPromptCacheTtlMs(model, {})).toBeUndefined();
		}
	});
	it("refreshes only when the role's idle probability makes a refresh pay", () => {
		expect(idleContinuationProbability("main")).toBe(0.15);
		expect(idleContinuationProbability("constructor")).toBe(0.15);
		// A small prefix: p × miss stays under the warmer's $0.05 minimum, so a gap past 5m is a miss.
		const small = planRetention({ ...span, prefixTokens: 10_000, gapsMs: [20 * MIN] });
		expect(small.costs.short).toBeCloseTo(0.048, 6);
	});
});

describe("compaction cost check", () => {
	const base = { model: opus, contextTokens: 150_000, keptTokens: 30_000, summaryTokens: 2_000 };
	it("compacts early only when the read saving over the remaining requests beats the summary and cold write", () => {
		const ten = compactionCost({ ...base, remainingRequests: 10, rewriteAnyway: false });
		expect(ten.oneTime).toBeCloseTo(0.03 + 0.04 + 0.15, 6);
		expect(ten.savingPerRequest).toBeCloseTo(0.024, 6);
		expect(ten.pays).toBe(true);
		expect(compactionCost({ ...base, remainingRequests: 5, rewriteAnyway: false }).pays).toBe(false);
	});
	it("credits the rewrite a cold cache pays anyway", () => {
		const cold = compactionCost({ ...base, remainingRequests: 5, rewriteAnyway: true });
		expect(cold.oneTime).toBeCloseTo(0.6 + 0.04 + 0.15 - 0.75, 6);
		expect(cold.pays).toBe(true);
		expect(compactionCost({ ...base, keptTokens: 200_000, remainingRequests: 99, rewriteAnyway: true }).pays).toBe(
			false,
		);
	});
});
