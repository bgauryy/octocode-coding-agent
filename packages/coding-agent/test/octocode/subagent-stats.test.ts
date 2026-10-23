import { describe, expect, it } from "vitest";
import { agentsCommand } from "../../src/octocode/subagents/command.ts";
import { agentStats, renderStats } from "../../src/octocode/subagents/stats.ts";
import type { Team } from "../../src/octocode/team/session.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0.1) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const report = (details: Record<string, unknown>, reportId: string) => ({
	type: "custom_message",
	customType: "octocode-agent-result",
	details: { summary: "x", reportId, ...details },
});

const foreground = (details: Record<string, unknown>, used: unknown) => ({
	type: "message",
	message: { role: "toolResult", toolName: "agent", content: [], usage: used, details },
});

const entries = [
	{ type: "message", message: { role: "user", content: "hi" } },
	// Background researcher: done, with a compaction.
	report(
		{
			id: "a1",
			profile: "researcher",
			status: "done",
			outcome: "done",
			usage: usage(1000, 200, 5000, 800),
			compactions: { done: 1, aborted: 0, failed: 0 },
			firstTurnTokens: 13000,
		},
		"r1",
	),
	// Same report delivered twice counts once.
	report(
		{ id: "a1", profile: "researcher", status: "done", outcome: "done", usage: usage(1000, 200, 5000, 800) },
		"r1",
	),
	// Background researcher: done but named no outcome (non-compliant).
	report({ id: "a2", profile: "researcher", status: "done", usage: usage(500, 100, 0, 0), firstTurnTokens: 15000 }, "r2"),
	// Background researcher: failed run.
	report(
		{
			id: "a3",
			profile: "researcher",
			status: "failed",
			outcome: "failed",
			usage: usage(0, 0, 0, 0, 0),
			startup: { failed: true },
		},
		"r3",
	),
	// Foreground run with no profile role: unpriced, partial, one ask.
	foreground(
		{
			id: "b1",
			profile: "",
			status: "done",
			outcome: "partial",
			unpriced: true,
			asks: [{ id: 1, text: "q", askedAt: 1 }],
		},
		usage(300, 50, 0, 0, 0),
	),
	// Foreground blocked.
	foreground({ id: "b2", profile: "general", status: "done", outcome: "blocked" }, usage(100, 10, 0, 0, 0.02)),
	// The launch of a background run is not a run.
	foreground({ id: "a4", profile: "researcher", status: "background" }, undefined),
	// Other tool results are ignored.
	{ type: "message", message: { role: "toolResult", toolName: "bash", usage: usage(1, 1), details: {} } },
];

describe("agent stats", () => {
	it("aggregates per profile across foreground and background runs", () => {
		const stats = agentStats(entries);
		expect(stats.map((item) => [item.profile, item.runs])).toEqual([
			["researcher", 3],
			["general", 2],
		]);
		const researcher = stats[0]!;
		expect(researcher.outcomes).toEqual({ done: 1, partial: 0, blocked: 0, failed: 1, unknown: 1 });
		expect(researcher.background).toBe(3);
		// Two runs ended on their own; one named an outcome.
		expect([researcher.ended, researcher.named]).toEqual([2, 1]);
		expect(researcher.tokens).toBe(1000 + 200 + 5000 + 800 + 600);
		expect(researcher.cost).toBeCloseTo(0.2);
		expect(researcher.compactions).toBe(1);
		expect(researcher.startupFailures).toBe(1);
		expect(researcher.cold).toEqual({ runs: 2, tokens: 28000 });
		const general = stats[1]!;
		expect(general.foreground).toBe(2);
		expect(general.outcomes).toMatchObject({ partial: 1, blocked: 1 });
		expect(general.unpriced).toBe(true);
		expect(general.asks).toBe(1);
		expect(general.tokens).toBe(460);
	});

	it("counts only runs carrying the startup marker as startup failures", () => {
		const stats = agentStats([
			report({ id: "a", profile: "x", status: "failed", usage: usage(0, 0), startup: { failed: true } }, "1"),
			report({ id: "b", profile: "x", status: "failed", usage: usage(5, 5), startup: undefined }, "2"),
			report({ id: "c", profile: "x", status: "failed", usage: usage(5, 5), startup: {} }, "3"),
		]);
		expect(stats[0]!.startupFailures).toBe(1);
	});

	it("renders a readable summary", () => {
		const text = renderStats(agentStats(entries));
		expect(text).toContain("Subagent stats for this session: 5 runs, 2 profiles");
		expect(text).toContain("researcher — 3 runs (3 background)");
		expect(text).toContain("done 1 · partial 0 · blocked 0 · failed 1 · unknown 1 · outcome word 50%");
		expect(text).toContain("cold start 14k avg");
		expect(text).toContain("general — 2 runs (2 foreground)");
		expect(text).toContain("cost ≈$0.02 + n/a");
		expect(text).toContain("1 ask");
		expect(renderStats([])).toBe("No subagent runs in this session yet.");
	});

	it("shows cost n/a when nothing was priced", () => {
		const text = renderStats(
			agentStats([foreground({ id: "b", profile: "general", status: "done", unpriced: true }, usage(10, 10, 0, 0, 0))]),
		);
		expect(text).toContain("cost n/a");
		expect(text).toContain("outcome word 0%");
	});
});

describe("/agents stats command", () => {
	it("is listed, completes, and reads the session entries", async () => {
		const command = agentsCommand({} as Team, new Map());
		expect(command.description).toContain("stats");
		expect(command.complete?.("st")?.map((item) => item.label)).toEqual(["stats"]);
		expect(command.complete?.("")?.map((item) => item.label)).toContain("stats");
		expect(command.complete?.("stats ")).toBeNull();
		const notes: Array<{ message: string; type: string }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: (message: string, type: string) => notes.push({ message, type }) },
			sessionManager: { getEntries: () => entries },
		};
		await command.handler("stats", ctx as never);
		expect(notes.at(-1)?.type).toBe("info");
		expect(notes.at(-1)?.message).toContain("researcher — 3 runs");
		await command.handler("bogus", ctx as never);
		expect(notes.at(-1)?.message).toContain("| stats]");
	});
});
