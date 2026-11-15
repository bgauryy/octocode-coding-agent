import { describe, expect, it } from "vitest";
import { prepare, type Entry } from "../../../src/octocode/profiler/index.ts";
import { deriveInsights } from "../../../src/octocode/profiler/insights.ts";
import { allEvents, type Lane } from "../../../src/octocode/profiler/timeline.ts";

const T = Date.UTC(2026, 10, 15, 10, 0, 0);
let n = 0;
const entry = (body: Record<string, unknown>): Entry => {
	const id = `e${n++}`;
	return {
		id,
		parentId: n > 1 ? `e${n - 2}` : null,
		timestamp: new Date(T + n * 1000).toISOString(),
		...body,
	} as unknown as Entry;
};
const reply = (usage: Record<string, number>) =>
	entry({
		type: "message",
		message: {
			role: "assistant",
			content: "x",
			provider: "anthropic",
			model: "m",
			timestamp: T + n * 1000,
			usage: { output: 1, input: 0, cacheRead: 0, cacheWrite: 0, ...usage },
		},
	});
const wave = (data: Record<string, unknown>) =>
	entry({ type: "custom", customType: "octocode-cleared-results", data: { results: [], ...data } });

const prices = { read: 0.2, write: 5, unit: "usd-per-million" };

function findings(entries: Entry[]) {
	const lane: Lane = { id: "main", prepared: prepare(entries) };
	const { events, messages } = allEvents({ sessionId: "s", lanes: [lane], traffic: [], now: T + 10_000_000 });
	return deriveInsights({ sessionId: "s", lanes: [lane], events, messages, now: T }).findings.filter((f) =>
		f.id.includes("clearing"),
	);
}

describe("the clearing ledger", () => {
	it("computes a warm wave's net from its recorded prices and the requests that followed", () => {
		n = 0;
		const entries = [
			entry({ type: "session" }),
			// Wave #129: the request before it held 144,912 tokens.
			reply({ input: 12, cacheRead: 144_000, cacheWrite: 900 }),
			wave({
				oldTokens: 32_820,
				suffixTokens: 58_000,
				remainingRequests: 33,
				prices,
				rewriteAnyway: false,
				cacheRead: 144_000,
			}),
			reply({ input: 10, cacheRead: 53_416, cacheWrite: 58_666 }),
			...Array.from({ length: 36 }, () => reply({ input: 10, cacheRead: 112_000, cacheWrite: 100 })),
			entry({ type: "compaction", summary: "s" }),
			reply({ input: 10, cacheRead: 1000, cacheWrite: 100 }),
		];
		const found = findings(entries);
		expect(found).toHaveLength(1);
		expect(found[0].id).toBe("main:clearing:1");
		expect(found[0].title).toMatch(/freed 32\.8k, wrote 58\.7k, 37 requests, net −\$0\.0[34]/);
		// 32,820 × $0.20/M × 37 − 58,666 × ($5 − $0.20)/M
		expect(found[0].cost).toBeGreaterThan(0.025);
		expect(found[0].cost).toBeLessThan(0.05);
		expect(found[0].tokens).toBe(58_666);
	});

	it("lists cold waves apart, with no write charged to them, and shows no net without catalog prices", () => {
		n = 0;
		const entries = [
			entry({ type: "session" }),
			reply({ input: 12, cacheRead: 100_000, cacheWrite: 0 }),
			wave({ prices, rewriteAnyway: true }),
			reply({ input: 10, cacheRead: 0, cacheWrite: 60_000 }),
			reply({ input: 10, cacheRead: 60_000, cacheWrite: 100 }),
			wave({ rewriteAnyway: false }),
			reply({ input: 10, cacheRead: 20_000, cacheWrite: 30_000 }),
		];
		const found = findings(entries);
		const cold = found.find((f) => f.id === "main:clearing-cold")!;
		expect(cold.title).toMatch(/^1 cold clearing wave: request 1: freed 40\.0k, wrote 60\.0k, 3 requests, net \$/);
		const warm = found.find((f) => f.id === "main:clearing:3")!;
		expect(warm.title).not.toMatch(/net/);
		expect(warm.cost).toBeUndefined();
	});
});
