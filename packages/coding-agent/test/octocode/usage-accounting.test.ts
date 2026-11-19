import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCacheMetrics } from "../../src/core/cache-stats.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { computeSessionStats } from "../../src/core/session-stats.ts";
import { customMessageUsage, getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { formatSpend } from "../../src/octocode/shared/format.ts";
import { formatSessionReport } from "../../src/octocode/shared/session-report.ts";
import { finishedStats } from "../../src/octocode/subagents/render.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

afterEach(() => vi.useRealTimers());

const usage = (cacheRead: number, cacheWrite: number, output: number, total: number) => ({
	input: 2,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: 2 + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

describe("agent row usage", () => {
	it("keeps a reply that finishes before the agent joins and adds it on join", () => {
		vi.useFakeTimers();
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const ctx = {
			cwd,
			isIdle: () => false,
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
		} as never;
		const team = new Team(
			asSetup({ sendMessage: () => undefined, appendEntry: () => undefined, getThinkingLevel: () => "off" }) as never,
			env,
		);
		team.start(ctx);
		// A resumed session's first reply re-writes the whole cache and can end before the join.
		team.onUsage(usage(14_613, 303_672, 100, 1.53), "anthropic/claude-opus", false);
		const me = team.join("main work");
		team.onUsage(usage(318_285, 283, 50, 0.08), undefined, false);
		expect(me).toMatchObject({
			input: 2 + 14_613 + 303_672 + 2 + 318_285 + 283,
			cacheRead: 14_613 + 318_285,
			output: 150,
			model: "anthropic/claude-opus",
		});
		expect(me.cost).toBeCloseTo(1.61);
		team.stop();
	});

	it("does not carry a previous session's early replies into the next one", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const env = { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") };
		const ctx = {
			cwd,
			isIdle: () => false,
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
		} as never;
		const team = new Team(
			asSetup({ sendMessage: () => undefined, appendEntry: () => undefined, getThinkingLevel: () => "off" }) as never,
			env,
		);
		team.start(ctx);
		team.onUsage(usage(10, 10, 10, 1), undefined, false);
		team.start(ctx);
		expect(team.join()).toMatchObject({ input: 0, cacheRead: 0, output: 0, cost: 0 });
		team.stop();
	});
});

describe("core usage totals", () => {
	const report = {
		type: "custom_message",
		id: "r1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "octocode-agent-result",
		content: "done",
		display: true,
		details: { usage: usage(9_000, 1_000, 500, 0.4) },
	} as unknown as SessionEntry;
	const plain = { ...report, id: "r2", details: { note: "no spend" } } as unknown as SessionEntry;

	it("reads a background subagent report's spend from details.usage", () => {
		expect(customMessageUsage(report)).toMatchObject({ cacheRead: 9_000, cacheWrite: 1_000, output: 500 });
		expect(customMessageUsage(plain)).toBeUndefined();
	});

	it("counts it in the cost breakdown and cache metrics", () => {
		expect(getUsageCostBreakdown([report, plain])).toEqual([
			{ key: "Tools/summaries", cost: 0.4, tokens: 2 + 500 + 9_000 + 1_000 },
		]);
		expect(computeCacheMetrics([report, plain]).tools).toMatchObject({
			requests: 1,
			cacheRead: 9_000,
			cacheWrite: 1_000,
		});
	});
});

describe("plan-billed runner usage", () => {
	// A runner on its own subscription records its tokens at no cost (`runner-child.ts`), with `billing: "plan"`.
	const background = {
		type: "custom_message",
		id: "b1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "octocode-agent-result",
		content: "done",
		display: true,
		details: { usage: usage(1_000, 0, 200, 0), billing: "plan", model: "claude-code/sonnet" },
	} as unknown as SessionEntry;
	const foreground = {
		type: "message",
		id: "f1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "agent",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 0,
			usage: usage(500, 0, 100, 0),
			details: { billing: "plan", model: "codex" },
		},
	} as unknown as SessionEntry;
	const metered = {
		...background,
		id: "b2",
		details: { usage: usage(0, 0, 50, 0.2), billing: "metered", model: "codex" },
	} as unknown as SessionEntry;
	const entries = [background, foreground, metered];
	const stats = computeSessionStats({ getEntries: () => entries } as never, { sessionFile: undefined, sessionId: "s" });
	const report = (list: SessionEntry[], spent = stats) =>
		formatSessionReport({
			stats: spent,
			entries: list,
			branch: list,
			prices: { getModel: () => undefined },
			selectedModelKey: "x/y",
		});

	it("lists each plan-billed route apart, marked plan, beside the priced usage", () => {
		expect(getUsageCostBreakdown(entries)).toEqual([
			{ key: "Tools/summaries", cost: 0.2, tokens: 2 + 50 },
			{ key: "claude-code/sonnet", cost: 0, tokens: 2 + 200 + 1_000, plan: true },
			{ key: "codex", cost: 0, tokens: 2 + 100 + 500, plan: true },
		]);
	});

	it("shows plan-billed usage as (sub) in /session, never as a $0 cost", () => {
		const text = report(entries);
		expect(text).toContain("claude-code/sonnet: (sub) (1.2k tokens)");
		expect(text).toContain("codex: (sub)");
		expect(text).toContain("Tools/summaries: $0.200");
		// A plan-billed route never prints a dollar figure; the cache-warming line is about this session, not them.
		expect(text).not.toMatch(/(sonnet|codex): \$/);
		const onlyPlan = [background];
		const planStats = computeSessionStats({ getEntries: () => onlyPlan } as never, {
			sessionFile: undefined,
			sessionId: "s",
		});
		expect(report(onlyPlan, planStats)).toContain("Total: (sub)");
	});

	it("shows (sub) in a finished runner child's row in place of a cost", () => {
		const totals = { input: 1_002, cacheRead: 1_000, output: 200, cost: 0, unpriced: false };
		expect(finishedStats(totals, { billing: "plan" })).toBe("↑2 +1k cached ↓200 · (sub)");
		expect(finishedStats({ ...totals, cost: 0.5 }, {})).toBe("↑2 +1k cached ↓200 · ≈$0.50");
		expect(formatSpend({ cost: 0, unpriced: false }, "plan")).toBe("(sub)");
		expect(formatSpend({ cost: 0, unpriced: false }, "metered")).toBe("");
	});
});
