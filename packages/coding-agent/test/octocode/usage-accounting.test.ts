import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCacheMetrics } from "../../src/core/cache-stats.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { customMessageUsage, getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { tmp } from "./helpers.ts";

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
		const ctx = { cwd, isIdle: () => false } as never;
		const team = new Team({ sendMessage: () => undefined } as never, env);
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
		const ctx = { cwd, isIdle: () => false } as never;
		const team = new Team({ sendMessage: () => undefined } as never, env);
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
