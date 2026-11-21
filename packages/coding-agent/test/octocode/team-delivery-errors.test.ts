import { describe, expect, it, vi } from "vitest";
import { Mail } from "../../src/octocode/team/mail.ts";
import { startBackground } from "../../src/octocode/subagents/run-execution.ts";
import { runDetails } from "../../src/octocode/subagents/tracking.ts";
import type { AgentRuns, Run } from "../../src/octocode/subagents/claim.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import { ReportGroups } from "../../src/octocode/subagents/report-groups.ts";

describe("Mail.inject onAccepted", () => {
	it("does not count a synchronous delivery as failed when onAccepted throws", () => {
		const mail = new Mail({ session: { sendMessage: () => undefined } });
		let result: boolean | undefined;
		expect(() => {
			result = mail.notice("hello", undefined, () => {
				throw new Error("db locked");
			});
		}).not.toThrow();
		expect(result).toBe(true);
	});
});

describe("startBackground when finish rejects after a successful child", () => {
	it("keeps the child's report and still ends the run", async () => {
		const reports: Report[] = [];
		const finished = vi.fn();
		const ended = vi.fn();
		const runs = {
			background: new Map(),
			changed: () => undefined,
			session: 1,
			read: { track: () => undefined, consume: () => false },
			team: {
				audit: { begin: () => undefined, hint: () => undefined, finish: finished },
				approvals: { noteExited: () => undefined },
			},
			groups: new ReportGroups(),
			ended,
			reports: { reportingChanged: () => undefined, add: (report: Report) => reports.push(report) },
		} as unknown as AgentRuns;
		const run = { identity: { id: "general-finish", role: "general", goal: "Check" }, route: {} } as Run;
		startBackground(
			runs,
			run,
			runDetails(run),
			"Check",
			async () => ({ text: "child findings", outcome: "done", usage: emptyUsage() }),
			async () => {
				throw new Error("attach failed");
			},
			"parent",
		);
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		expect(reports[0]?.content).toContain("child findings");
		expect(reports[0]?.content).not.toContain("report could not be built");
		expect(reports[0]?.details).toMatchObject({ status: "done" });
		await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("general-finish", expect.anything()));
		expect(finished).toHaveBeenCalled();
	});
});
