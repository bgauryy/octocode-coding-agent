import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/utils/atomic-file.ts";
import { fenceUntrusted, fencedParts } from "../../src/octocode/shared/fence.ts";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import { referencedContentBlock, resolveReferences } from "../../src/octocode/shared/references.ts";
import { sessionChildren, type SessionChild } from "../../src/octocode/shared/session-children.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { tmp } from "./helpers.ts";
import { expandPromptRefs } from "../../src/octocode/external/refs.ts";
import { describeWork, unreportedWork } from "../../src/octocode/sessions/work.ts";
import { taskReferences } from "../../src/octocode/subagents/task-text.ts";

const child = (over: Partial<SessionChild> = {}): SessionChild => ({
	id: "worker",
	profile: "general",
	goal: "review",
	status: "done",
	...over,
});
const resolve = (children: SessionChild[]) =>
	resolveReferences(
		children.map((item) => `report:${item.id}`),
		{
			requester: "parent",
			children: () => children,
		},
	);
function recorded(scratch: string, report: ReturnType<ReportTracker["result"]>, run: number, custom = false) {
	const details = {
		id: "worker",
		profile: "general",
		status: "done",
		outcome: report.outcome,
		runId: `run-${run}`,
		startedAt: run,
		session: { dir: path.join(scratch, "session") },
		...report,
	};
	const content = fenceUntrusted("Subagent worker", report.text);
	return custom
		? {
				type: "custom_message",
				customType: AGENT_RESULT_TYPE,
				timestamp: new Date(run).toISOString(),
				content,
				details,
			}
		: {
				type: "message",
				message: { role: "toolResult", toolName: "agent", details, content: [{ type: "text", text: content }] },
			};
}

describe("report reference freshness", () => {
	it("keeps a same-process failed follow-up's qualification in the reference", async () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`done: earlier evidence\n${"detail ".repeat(2000)}`, "stop");
		report.result();
		report.incoming("custom", "background check");
		report.answer(undefined, "error", "verification failed");
		const result = await resolve(sessionChildren([recorded(scratch, report.result(), 1)]));
		expect(result.errors).toEqual([]);
		expect(result.resolved[0].text).toContain("A later follow-up turn failed: verification failed");
	});
	it.each([false, true])(
		"keeps a short correction current after a long report (message resume: %s)",
		async (custom) => {
			const scratch = tmp();
			const first = new ReportTracker(scratch);
			first.answer(`partial: OLD FINDING\n${"old detail ".repeat(2000)}`, "stop");
			const old = first.result();
			const second = new ReportTracker(scratch);
			second.answer("done: NEW FINDING; previous conclusion withdrawn", "stop");
			const entries = [recorded(scratch, old, 1), recorded(scratch, second.result(), 2, custom)];
			const { resolved, errors } = await resolve(sessionChildren(entries));
			expect(errors).toEqual([]);
			expect(fencedParts(resolved[0].text)?.body).toBe(second.result().body);
			expect(resolved[0].text).not.toContain("OLD FINDING");
		},
	);

	it("publishes immutable digest-bound artifacts and keeps the previous long report readable", () => {
		const scratch = tmp();
		const first = new ReportTracker(scratch);
		const original = `partial: original\n${"old detail ".repeat(2000)}`;
		first.answer(original, "stop");
		const saved = first.result() as ReturnType<ReportTracker["result"]> & {
			reportArtifact?: { path?: string; sha256: string };
		};
		expect(saved.reportArtifact?.sha256).toBe(sha256(original));
		expect(saved.reportArtifact?.path).toMatch(/report-[a-f0-9]{64}\.md$/);
		const next = new ReportTracker(scratch);
		next.answer(`done: replacement\n${"new detail ".repeat(2000)}`, "stop");
		next.result();
		expect(fs.readFileSync(saved.reportArtifact!.path!, "utf8")).toBe(original);
	});

	it("clears the old report while a newer task has not reported", async () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer("done: old answer", "stop");
		const next = {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "agent",
				details: {
					id: "worker",
					profile: "general",
					status: "background",
					runId: "run-2",
					startedAt: 2,
				},
				content: [{ type: "text", text: "Started worker" }],
			},
		};
		const result = await resolve(sessionChildren([recorded(scratch, report.result(), 1), next]));
		expect(result.resolved).toEqual([]);
		expect(result.errors).toEqual(["report:worker: worker has not reported yet"]);
	});

	it("does not treat a discovered disk file as the answer to an in-flight task", async () => {
		const scratch = tmp();
		const file = path.join(scratch, "report.md");
		fs.writeFileSync(file, "done: older run");
		const result = await resolve([child({ status: "background", report: file })]);
		expect(result.resolved).toEqual([]);
		expect(result.errors).toEqual(["report:worker: worker has not reported yet"]);
	});

	it("does not advertise an earlier report as a resumed task's unreported work", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`done: earlier\n${"detail ".repeat(2000)}`, "stop");
		const entry = recorded(scratch, report.result(), 2);
		entry.message!.details.status = "background";
		const [work] = unreportedWork([recorded(scratch, report.result(), 1), entry]);
		expect(describeWork(work)).not.toContain("report.md");
		expect(work.files?.report).toBeUndefined();
	});

	it("uses a legacy correction's transcript instead of the previous disk artifact", async () => {
		const scratch = tmp();
		fs.writeFileSync(path.join(scratch, "report.md"), "partial: obsolete");
		const report = new ReportTracker();
		report.answer("done: legacy correction", "stop");
		const entry = recorded(scratch, report.result(), 1);
		delete entry.message!.details.reportArtifact;
		const result = await resolve(sessionChildren([entry]));
		expect(fencedParts(result.resolved[0].text)?.body).toBe("done: legacy correction");
	});

	it("does not reuse a report after a newer message continuation fails without an answer", async () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer("done: old answer", "stop");
		const failure = {
			type: "custom_message",
			customType: AGENT_RESULT_TYPE,
			content: "Stopped without an answer",
			details: {
				id: "worker",
				status: "failed",
				runId: "run-2",
				startedAt: 2,
			},
		};
		const result = await resolve(sessionChildren([recorded(scratch, report.result(), 1), failure]));
		expect(result.resolved).toEqual([]);
		expect(result.errors.join(" ")).toContain("no saved report");
	});

	it.each(["changed", "symlink", "hardlink"])("refuses a versioned artifact that became %s", async (kind) => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`done: original\n${"detail ".repeat(2000)}`, "stop");
		const saved = report.result();
		const artifact = saved.reportArtifact!;
		if (kind === "changed") fs.writeFileSync(artifact.path!, "done: forged content");
		else {
			const target = path.join(tmp(), "private.txt");
			fs.writeFileSync(target, "private");
			fs.unlinkSync(artifact.path!);
			if (kind === "symlink") fs.symlinkSync(target, artifact.path!);
			else fs.linkSync(target, artifact.path!);
		}
		const result = await resolve(sessionChildren([recorded(scratch, saved, 1)]));
		expect(result.resolved).toEqual([]);
		expect(result.errors.join(" ")).toContain("refused");
	});
});

describe("bounded reference handoffs", () => {
	it("refuses an external handoff whose omitted report sections exist only on this machine", async () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`done: evidence\n${"detail ".repeat(2000)}`, "stop");
		const children = sessionChildren([recorded(scratch, report.result(), 1)]);
		await expect(
			expandPromptRefs("Review this", ["report:worker"], {
				requester: "parent",
				children: () => children,
			}),
		).rejects.toThrow(/nothing was sent.*summary/i);
	});

	it("refuses report excerpts when the child lacks artifact access", async () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`done: evidence\n${"detail ".repeat(2000)}`, "stop");
		const entries = [recorded(scratch, report.result(), 1)];
		await expect(
			taskReferences(
				"Review report:worker",
				{ id: "parent", readMessage: () => ({ error: "not found" }) },
				{ sessionManager: { getEntries: () => entries } },
				"none",
			),
		).rejects.toThrow(/No subagent started.*summary/);
	});
	it("carries a concise report excerpt, its whole-content hash and an accessible artifact pointer", async () => {
		const scratch = tmp();
		const whole = `done: evidence\n${"detail ".repeat(10000)}`;
		const report = new ReportTracker(scratch);
		report.answer(whole, "stop");
		const result = await resolve(sessionChildren([recorded(scratch, report.result(), 1)]));
		expect(result.errors).toEqual([]);
		expect(result.resolved[0].text.length).toBeLessThan(6000);
		expect(result.resolved[0].text).toContain("Excerpt");
		expect(result.resolved[0].text).toContain("report-");
		expect(result.resolved[0].sha).toBe(sha256(whole).slice(0, 12));
	});

	it("rejects an oversized aggregate without dispatching a partial set", async () => {
		const result = await resolve(
			Array.from({ length: 16 }, (_, i) => child({ id: `worker-${i}`, reportText: "detail ".repeat(500) })),
		);
		expect(result.resolved).toEqual([]);
		expect(result.errors.join(" ")).toMatch(/handoff.*limit/i);
		expect(referencedContentBlock(result.resolved).length).toBeLessThanOrEqual(32768);
	});

	it("refuses to silently cut a long message's instructions", async () => {
		const result = await resolveReferences(["msg#1"], {
			requester: "parent",
			children: () => [],
			messages: {
				readMessage: () => ({ id: 1, from: "parent", at: 1, text: `${"instruction ".repeat(1000)}IMPORTANT END` }),
			},
		});
		expect(result.resolved).toEqual([]);
		expect(result.errors.join(" ")).toMatch(/summary|narrow|smaller/i);
	});
});
