import { describe, expect, it } from "vitest";
import { prepare, type Entry } from "../../src/octocode/profiler/index.ts";
import { deriveInsights } from "../../src/octocode/profiler/insights.ts";
import { allEvents, type Lane } from "../../src/octocode/profiler/timeline.ts";

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
let n = 0;
const entry = (ms: number, body: Record<string, unknown>): Entry => {
	const id = `e${n++}`;
	return {
		id,
		parentId: n > 1 ? `e${n - 2}` : null,
		timestamp: new Date(T + ms).toISOString(),
		...body,
	} as unknown as Entry;
};
const system = (ms: number, sections: Record<string, string>, extra = {}) =>
	entry(ms, { type: "message", message: { role: "system", content: "b".repeat(4000), sections, ...extra } });
const reply = (ms: number, usage: Record<string, number>) =>
	entry(ms, {
		type: "message",
		message: {
			role: "assistant",
			content: "x",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: T + ms - 500,
			durationMs: 500,
			usage: { output: 1, input: 0, cacheRead: 0, cacheWrite: 0, ...usage },
		},
	});
const result = (ms: number, isError: boolean, durationMs: number) =>
	entry(ms, { type: "message", message: { role: "toolResult", toolName: "bash", isError, durationMs, content: "c" } });

function insightsOf(entries: Entry[], parentId?: string) {
	const lane: Lane = { id: "agent", ...(parentId ? { parentId } : {}), prepared: prepare(entries) };
	const { events, messages } = allEvents({ sessionId: "s", lanes: [lane], traffic: [], now: T + 10_000_000 });
	return deriveInsights({ sessionId: "s", lanes: [lane], events, messages, now: T }).findings;
}

describe("profiler insights", () => {
	it("names the cause of a rewrite, a cold child start and an idle expiry, most costly first", () => {
		n = 0;
		const entries = [
			entry(0, { type: "session" }),
			system(1000, { environment: "date 1" }, { toolsAdded: [{ name: "read", description: "d".repeat(800) }] }),
			entry(2000, { type: "message", message: { role: "user", content: "go" } }),
			reply(3000, { input: 10, cacheWrite: 30_000 }),
			system(4000, { environment: "date 2" }),
			entry(5000, { type: "message", message: { role: "user", content: "next" } }),
			reply(6000, { input: 10, cacheRead: 2000, cacheWrite: 60_000 }),
			entry(7000, { type: "message", message: { role: "user", content: "later" } }),
			reply(2 * 3_600_000, { input: 10, cacheWrite: 62_000 }),
		];
		const findings = insightsOf(entries, "main");
		const kinds = findings.map((f) => f.kind);
		expect(kinds).toEqual(expect.arrayContaining(["cache-cold-start", "cache-rewrite", "cache-idle-expiry"]));
		const rewrite = findings.find((f) => f.kind === "cache-rewrite")!;
		expect(rewrite.title).toMatch(/section update \(environment\)/);
		expect(rewrite.evidence).toEqual([{ agentId: "agent", request: 1 }]);
		const severities = findings.map((f) => f.severity);
		expect(severities).toEqual(
			[...severities].sort((a, b) => (a === b ? 0 : a === "high" ? -1 : b === "high" ? 1 : 0)),
		);
	});

	it("flags repeated tool errors and slow tools with their events as evidence", () => {
		n = 0;
		const entries = [
			entry(0, { type: "session" }),
			...[1, 2, 3].map((i) => result(i * 1000, true, 100)),
			result(70_000, false, 65_000),
		];
		const findings = insightsOf(entries);
		expect(findings.find((f) => f.kind === "tool-errors")?.evidence).toHaveLength(3);
		expect(findings.find((f) => f.kind === "slow-tool")?.waitedMs).toBe(65_000);
	});
});
