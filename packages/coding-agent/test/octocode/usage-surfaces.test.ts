import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { computeCacheMetrics, computeCacheWaste } from "../../src/core/cache-stats.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { computeSessionStats } from "../../src/core/session-stats.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { formatCost, formatTokenUsage } from "../../src/octocode/shared/format.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerFooter } from "../../src/octocode/ui/footer.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Every surface that totals a session's spend must read the same entries. The session below mixes all of them:
 * a reply, a cache refresh, a compaction summary request (the default compaction records its spend as a `usage` entry and
 * leaves the `compaction` entry without usage), a background subagent report and a foreground subagent result.
 *
 *                       input  cacheRead cacheWrite output cost
 *   reply               1000   9000      0          100    0.10
 *   cache_warm usage    0      10000     0          1      0.02
 *   compaction_attempt  2000   0         8000       500    0.30
 *   background report   100    900       0          50     0.05
 *   foreground result   10     40        0          5      0.01
 *   total               3110   19940     8000       656    0.48
 */
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, total: number): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const TOTAL = { input: 3110, output: 656, cacheRead: 19_940, cacheWrite: 8000, cost: 0.48 };

function mixedSession(): SessionManager {
	const sm = SessionManager.inMemory();
	sm.appendMessage({ role: "user", content: "go", timestamp: 1 });
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(1000, 9000, 0, 100, 0.1),
		stopReason: "stop",
		timestamp: 2,
	});
	sm.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage(0, 10_000, 0, 1, 0.02));
	sm.appendUsage("compaction_attempt", "anthropic", "claude-sonnet-4-5", usage(2000, 0, 8000, 500, 0.3));
	const kept = sm.appendMessage({ role: "user", content: "next", timestamp: 3 });
	sm.appendCompaction("summary", kept, 10_000);
	sm.appendCustomMessageEntry("octocode-agent-result", "done", true, {
		usage: usage(100, 900, 0, 50, 0.05),
		unpriced: false,
	});
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "agent",
		content: [{ type: "text", text: "sub" }],
		usage: usage(10, 40, 0, 5, 0.01),
		isError: false,
		timestamp: 4,
	} as never);
	return sm;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

async function footerText(sm: SessionManager, events: Array<[string, unknown]> = []): Promise<string> {
	const fake = fakeHost();
	registerFooter(fake.api);
	const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
	ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: false, contextWindow: 200_000 };
	ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
	ctx.sessionManager.getEntries = () => sm.getEntries();
	await fake.emit("session_start", {}, ctx);
	const component = ctx.ui.footer({ requestRender: () => undefined }, theme, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
	});
	for (const [name, payload] of events) await fake.emit(name, payload, ctx);
	return (component.render(200) as string[]).join("\n");
}

describe("session spend is the same on every surface", () => {
	it("/session totals count every entry that carries spend, including a background subagent report", () => {
		const sm = mixedSession();
		const stats = computeSessionStats(sm, { sessionFile: undefined, sessionId: sm.getSessionId() });
		expect(stats.tokens).toEqual({
			input: TOTAL.input,
			output: TOTAL.output,
			cacheRead: TOTAL.cacheRead,
			cacheWrite: TOTAL.cacheWrite,
			total: 3110 + 656 + 19_940 + 8000,
		});
		expect(stats.cost).toBeCloseTo(TOTAL.cost, 10);
	});

	it("/session's cost breakdown reconciles with its total", () => {
		const sm = mixedSession();
		const stats = computeSessionStats(sm, { sessionFile: undefined, sessionId: sm.getSessionId() });
		const breakdown = getUsageCostBreakdown(sm.getEntries());
		expect(breakdown.reduce((sum, entry) => sum + entry.cost, 0)).toBeCloseTo(stats.cost, 10);
		expect(breakdown.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(stats.tokens.total);
	});

	it("the footer's replay counts the compaction summary request and the cache refresh, as /session does", async () => {
		const text = await footerText(mixedSession());
		// ↑ = input + cache writes = 3110 + 8000; cached = 19940; ↓ = 656; tokens = ↑ + ↓.
		expect(text).toContain("11.8k tokens (↑11.1k +19.9k cached ↓656)");
		expect(text).toContain("≈$0.48");
	});

	it("the footer picks up spend recorded outside a reply (a compaction summary) when the compaction ends", async () => {
		const sm = SessionManager.inMemory();
		const fake = fakeHost();
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" }) as unknown as Record<string, any>;
		ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: false, contextWindow: 200_000 };
		ctx.getContextUsage = () => ({ tokens: null, contextWindow: 200_000, percent: null });
		ctx.sessionManager.getEntries = () => sm.getEntries();
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		// The default compaction records its request as a `usage` entry and the compaction entry carries none.
		sm.appendUsage("compaction_attempt", "anthropic", "claude-sonnet-4-5", usage(2000, 0, 8000, 500, 0.3));
		const entryId = sm.appendCompaction("summary", null, 10_000);
		await fake.emit("session_compact", { compactionEntry: sm.getEntry(entryId) }, ctx);
		const text = (component.render(200) as string[]).join("\n");
		expect(text).toContain("≈$0.30");
		expect(text).toContain("(↑10k ↓500)");
		// A later reply must not count the same entry twice.
		await fake.emit("message_end", { message: { role: "assistant", usage: usage(100, 0, 0, 10, 0.01) } }, ctx);
		expect((component.render(200) as string[]).join("\n")).toContain("≈$0.31");
	});

	it("cache metrics keep each source in its own bucket and none is counted twice", () => {
		const metrics = computeCacheMetrics(mixedSession().getEntries());
		expect(metrics.conversation).toMatchObject({ requests: 1, promptTokens: 10_000, cacheRead: 9000, hitRate: 0.9 });
		expect(metrics.warming).toMatchObject({ requests: 1, promptTokens: 10_000, cacheRead: 10_000, hitRate: 1 });
		expect(metrics.compaction).toMatchObject({
			requests: 1,
			promptTokens: 10_000,
			cacheRead: 0,
			cacheWrite: 8000,
			hitRate: 0,
		});
		// The background report and the foreground result are both subagent runs.
		expect(metrics.tools).toMatchObject({ requests: 2, promptTokens: 1050, cacheRead: 940 });
		expect(metrics.tools.hitRate).toBeCloseTo(940 / 1050, 10);
	});
});

describe("cache share across a compaction", () => {
	const reply = (input: number, cacheRead: number, cacheWrite: number, timestamp: number) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(input, cacheRead, cacheWrite, 10, 0),
		stopReason: "stop" as const,
		timestamp,
	});

	it("keeps the pre-compaction turns in the totals, shows the rebuilt prefix as a miss in the share and does not call it waste", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(reply(0, 0, 10_000, 1)); // cold start: writes the prefix
		sm.appendMessage(reply(0, 10_000, 1000, 2)); // healthy: reads it, extends it
		const kept = sm.appendMessage({ role: "user", content: "next", timestamp: 3 });
		sm.appendCompaction("summary", kept, 11_000);
		sm.appendMessage(reply(0, 0, 4000, 4)); // the summarized prefix is new content: all written, none read
		sm.appendMessage(reply(0, 4000, 500, 5)); // the new prefix is read again

		const { conversation } = computeCacheMetrics(sm.getEntries());
		// Prompt: 10000 + 11000 + 4000 + 4500 = 29500; reads: 0 + 10000 + 0 + 4000 = 14000.
		expect(conversation).toMatchObject({ requests: 4, promptTokens: 29_500, cacheRead: 14_000, cacheWrite: 15_500 });
		expect(conversation.hitRate).toBeCloseTo(14_000 / 29_500, 12);
		// The rebuilt prefix is expected after a compaction: it is not re-billed history.
		const waste = computeCacheWaste(sm.getEntries(), { getModel: () => undefined });
		expect(waste).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
	});

	it("still counts a real miss after the first post-compaction turn", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(reply(0, 0, 10_000, 1));
		const kept = sm.appendMessage({ role: "user", content: "next", timestamp: 2 });
		sm.appendCompaction("summary", kept, 10_000);
		sm.appendMessage(reply(0, 0, 4000, 3));
		sm.appendMessage(reply(0, 0, 4500, 4)); // should have read the 4000-token prefix
		const waste = computeCacheWaste(sm.getEntries(), { getModel: () => undefined });
		expect(waste.missedTokens).toBe(4000);
		expect(waste.missCount).toBe(1);
	});
});

describe("an agent's row in the agent list", () => {
	it("shows uncached prompt tokens, then cache reads, then output: one reply's prompt is counted once", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const ctx = {
			cwd,
			isIdle: () => false,
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
		} as never;
		const team = new Team(
			{ sendMessage: () => undefined, appendEntry: () => undefined, getThinkingLevel: () => "off" } as never,
			env,
		);
		team.start(ctx);
		const me = team.join("accounting");
		// Reply 1 writes a 1M prompt (600k uncached + 400k written); reply 2 reads 50.1M over many requests.
		team.onUsage(usage(600_000, 0, 400_000, 100_000, 10), undefined, false);
		team.onUsage(usage(0, 50_100_000, 0, 155_000, 13.48), undefined, false);
		// `input` is the whole prompt: 1M + 50.1M. The cache share is cacheRead / input.
		expect(me).toMatchObject({ input: 51_100_000, cacheRead: 50_100_000, output: 255_000 });
		expect(me.cacheRead / me.input).toBeCloseTo(50_100_000 / 51_100_000, 12);
		expect(formatTokenUsage(me)).toBe("↑1M +50.1M cached ↓255k");
		expect(formatCost(me)).toBe("≈$23.48");
		team.stop();
	});
});
