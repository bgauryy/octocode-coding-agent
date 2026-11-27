import { readFile } from "node:fs/promises";
import { TEXT_MAX_CHARS } from "../../src/utils/output-budget.ts";
import { tmp } from "./helpers.ts";
import { afterEach, describe, expect, it } from "vitest";
import { asyncJobsFor } from "../../src/octocode/jobs/registry.ts";
import { runBudgeted } from "../../src/octocode/jobs/tool.ts";
import { taskDetails, taskReport } from "../../src/octocode/jobs/report.ts";
import type { JobOutcome } from "../../src/octocode/jobs/async-jobs.ts";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

const opened: object[] = [];
function session() {
	const owner = {};
	opened.push(owner);
	const reports: Array<{ id: string; outcome: JobOutcome }> = [];
	const work = new RunningWork();
	asyncJobsFor(owner).attach({
		work,
		deliver: (job, outcome) => void reports.push({ id: job.id, outcome }),
		failed: (_job, error) => {
			throw error;
		},
	});
	return { owner, reports, work };
}

afterEach(async () => {
	for (const owner of opened.splice(0)) await asyncJobsFor(owner).stopAll("session end");
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (owner: object, foregroundMs: number, tool = "web") => ({
	session: owner,
	tool,
	title: "x",
	foregroundMs,
});

describe("runBudgeted", () => {
	it("delivers a bounded report with readable full text and image files for any model", async () => {
		const dir = tmp();
		const huge = "あ".repeat(TEXT_MAX_CHARS + 1);
		const report = await taskReport(
			{ id: "task-7", tool: "mcp", title: "read", startedAt: 0 },
			{
				kind: "done",
				durationMs: 100,
				value: {
					content: [
						{ type: "image", mimeType: "image/png", data: Buffer.from("image fixture").toString("base64") },
						{ type: "text", text: huge },
					],
				},
			},
			() => dir,
		);
		expect(report).toContain("[task-7");
		expect(report.length).toBeLessThan(TEXT_MAX_CHARS);
		expect(await readFile(report.match(/Image \(image\/png\): (.+)/)![1], "utf8")).toBe("image fixture");
		expect(await readFile(report.match(/Full task output: (.+)/)![1], "utf8")).toBe(huge);
	});

	it("gives a fast call its own result and starts no job", async () => {
		const { owner, reports } = session();
		const result = await runBudgeted(call(owner, 500), async () => text("hi"));
		expect(result.content[0]).toEqual({ type: "text", text: "hi" });
		expect(reports).toEqual([]);
	});

	it("returns a job id fast for a slow call and delivers the result to the session once", async () => {
		const { owner, reports, work } = session();
		let release: () => void = () => undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const began = Date.now();
		const reply = await runBudgeted(call(owner, 10, "models"), async () => {
			await slow;
			return text("checked 3 providers");
		});
		expect(Date.now() - began).toBeLessThan(1000);
		expect(reply.details).toMatchObject({ kind: "job-started", job: "task-1" });
		expect(reply.content[0]).toMatchObject({ text: expect.stringContaining("task-1") });
		expect(work.all()).toHaveLength(1);
		release();
		await asyncJobsFor(owner).settle();
		expect(reports).toHaveLength(1);
		const { id, outcome } = reports[0];
		expect(await taskReport({ id, tool: "models", title: "x", startedAt: 0 }, outcome, tmp)).toContain(
			"checked 3 providers",
		);
	});

	it("reports a slow call that fails as failed", async () => {
		const { owner, reports } = session();
		await runBudgeted(call(owner, 5), async () => {
			await sleep(30);
			throw new Error("connection reset");
		});
		await asyncJobsFor(owner).settle();
		const job = { id: "task-1", tool: "web", title: "x", startedAt: 0 };
		expect(taskDetails(job, reports[0].outcome).ok).toBe(false);
		expect(await taskReport(job, reports[0].outcome, tmp)).toContain("connection reset");
	});

	it("drops progress updates of a call that already returned its job id", async () => {
		const { owner } = session();
		const seen: boolean[] = [];
		await runBudgeted(call(owner, 5), async (_signal, foreground) => {
			seen.push(foreground());
			await sleep(30);
			seen.push(foreground());
			return text("done");
		});
		await asyncJobsFor(owner).settle();
		expect(seen).toEqual([true, false]);
	});

	it("stops a running job when its session ends", async () => {
		const { owner, reports } = session();
		let aborted = false;
		await runBudgeted(call(owner, 5), (signal) => {
			return new Promise<ReturnType<typeof text>>((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		});
		await asyncJobsFor(owner).stopAll("session end");
		expect(aborted).toBe(true);
		expect(reports[0].outcome).toMatchObject({ kind: "stopped", by: "session end" });
	});

	it("keeps a subagent's call in the foreground", async () => {
		const { owner, reports } = session();
		process.env.OCTOCODE_SUBAGENT = "1";
		try {
			const reply = await runBudgeted(call(owner, 1), async () => {
				await sleep(20);
				return text("slow but waited");
			});
			expect(reply.content[0]).toMatchObject({ text: "slow but waited" });
			expect(reports).toEqual([]);
		} finally {
			delete process.env.OCTOCODE_SUBAGENT;
		}
	});
});
