import { expect, it, vi } from "vitest";
import { startBackground } from "../../src/octocode/subagents/run-execution.ts";
import { runDetails } from "../../src/octocode/subagents/tracking.ts";
import type { AgentRuns, Run } from "../../src/octocode/subagents/claim.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";

it("keeps the launch generation when the ordinary background report path fails", async () => {
	const reports: Report[] = [];
	let attempts = 0;
	const runs = {
		background: new Map(),
		changed: () => undefined,
		session: 1,
		read: { track: () => undefined, consume: () => false },
		// The run's audit row opens, takes an end hint and closes (`run-audit.ts`, `end-hint.ts`); nothing else of the team
		// is reached here.
		team: { audit: { begin: () => undefined, hint: () => undefined, finish: () => undefined } },
		reports: {
			add: (report: Report) => {
				if (++attempts <= 2) throw new Error("report delivery unavailable");
				reports.push(report);
			},
		},
	} as unknown as AgentRuns;
	const run = { identity: { id: "general-generation", role: "general", goal: "Check" }, route: {} } as Run;
	const details = runDetails(run);
	const next = runDetails(run);
	expect(details.runId).toEqual(expect.any(String));
	expect(next.runId).not.toBe(details.runId);
	startBackground(
		runs,
		run,
		details,
		"Check",
		async () => ({ text: "done", outcome: "done", usage: emptyUsage() }),
		async () => "",
		"parent",
	);
	await vi.waitFor(() => expect(reports).toHaveLength(1));
	expect(reports[0]?.details).toMatchObject({ runId: details.runId, status: "failed" });
	expect(reports[0]?.content).toContain("report could not be built");
});
