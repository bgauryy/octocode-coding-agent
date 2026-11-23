import type { Api, AssistantMessage, Model, RequestLayer, RequestTrace, Usage } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { getPromptCacheTtlMs } from "../../src/core/cache-warmer/economics.ts";
import { firstChangedArea, formatLayerChange } from "../../src/core/cache-warmer/first-change.ts";
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
	it("counts subagent runs and summaries in the turn they landed, so the turns add up to the session total", () => {
		const spent = (total: number) => usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
		const toolResult = {
			type: "message",
			id: "tr",
			parentId: null,
			timestamp: "",
			message: { role: "toolResult", toolCallId: "c", toolName: "agent", content: [], usage: spent(0.4), timestamp: 0 },
		} as unknown as SessionEntry;
		const report = {
			type: "custom_message",
			id: "cm",
			parentId: null,
			timestamp: "",
			customType: "octocode-agent-report",
			content: "",
			display: false,
			details: { usage: { ...spent(0.25), lowerBound: true } },
		} as unknown as SessionEntry;
		const compaction = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "",
			summary: "s",
			firstKeptEntryId: "e1",
			tokensBefore: 1,
			usage: spent(0.05),
		} as unknown as SessionEntry;
		const turns = turnCosts([
			user(),
			entry(assistant(0.1)),
			toolResult,
			entry(assistant(0.1)),
			user(),
			report,
			compaction,
			entry(assistant(0.2)),
		]);
		expect(turns.map((turn) => turn.cost)).toEqual([expect.closeTo(0.6, 10), expect.closeTo(0.5, 10)]);
		expect(turns.map((turn) => turn.lowerBound)).toEqual([false, true]);
		expect(turns.map((turn) => turn.requests)).toEqual([2, 1]);
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
		expect(text).toContain("$/turn: ≈$0.2350 average over 2 turns (at least)");
		expect(text).toContain("Turn 1: ≈$0.1200 (2 requests, first change: cold)");
		expect(text).toContain("Turn 2: ≈$0.3500 (1 request, first change: system[0])");
	});
});

describe("provider-managed retention", () => {
	it("gives the warmer no lifetime to plan with where the TTL is not controllable (Gemini, xAI)", () => {
		for (const model of [getBuiltinModel("google", "gemini-2.5-pro"), getBuiltinModel("xai", "grok-4.3")])
			expect(getPromptCacheTtlMs(model, {})).toBeUndefined();
	});
});
