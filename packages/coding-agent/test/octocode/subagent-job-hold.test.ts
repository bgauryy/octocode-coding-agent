import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { foregroundPlan } from "../../src/octocode/files/bash/auto.ts";
import { registerNativeSessionLifecycle } from "../../src/octocode/session-lifecycle.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";

const posix = process.platform !== "win32";

/** A subagent session (RPC child) with the real bash tool and the native run-end hold. */
async function child({ isSubagent = true, ...options }: { jobHoldMs?: number; isSubagent?: boolean } = {}) {
	const root = tmp();
	const jobs = new BashJobs(tmp());
	const harness = await createHarness({
		sessionManager: SessionManager.create(root, path.join(root, "sessions")),
		features: testFeatures([
			(api) => {
				registerBashTool(api, new Subcommands(), jobs, () => ({ backgroundAfterSeconds: 0 }));
				registerNativeSessionLifecycle(api, {
					isSubagent,
					team: { interrupted: new AbortController().signal, id: "child" } as never,
					permission: { shutdown: () => undefined } as never,
					jobs,
					...options,
				});
			},
		]),
	});
	await harness.session.bindFeatures({});
	return { harness, jobs };
}

const requestText = (context: { messages: Parameters<typeof getMessageText>[0][] }) =>
	context.messages.map((message) => getMessageText(message)).join("\n");

describe.runIf(posix)("a subagent whose own background job is still running when it answers (B82)", () => {
	const open: Array<{ harness: Harness; jobs: BashJobs }> = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const { harness, jobs } of open.splice(0)) {
			await jobs.stopAll("session end");
			harness.cleanup();
		}
	});

	it("holds the run until the job ends, keeps the untimed job running, and gives its completion to the model in one more turn", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		let last = "";
		session.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "sleep 1; echo job-finished-marker", background: true, reason: "suite" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("I'll wait for the completion message."),
			(context) => {
				last = requestText(context);
				return fauxAssistantMessage("done. The suite printed job-finished-marker.");
			},
		]);
		await session.harness.session.prompt("run the suite and report");
		expect(session.harness.faux.state.callCount).toBe(3);
		expect(last).toContain("job-finished-marker");
		expect(last).not.toMatch(/stopped[^\n]*run end/i);
		expect(session.jobs.running()).toHaveLength(0);
	});

	it("delivers a job that ends mid-run at the child's next step", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		let third = "";
		session.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "echo early-job-marker", background: true, reason: "quick" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2", reason: "other work" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				third = requestText(context);
				return fauxAssistantMessage("done.");
			},
		]);
		await session.harness.session.prompt("work");
		expect(session.harness.faux.state.callCount).toBe(3);
		expect(third).toContain("early-job-marker");
	});

	it("warns once when the job outlasts the hold, then stops it at run end if the child answers again", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child({ jobHoldMs: 300 });
		open.push(session);
		let warned = "";
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true, reason: "server" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("waiting for it"),
			(context) => {
				warned = requestText(context);
				return fauxAssistantMessage("done. I leave the server; it is stopped at run end.");
			},
		]);
		const started = Date.now();
		await session.harness.session.prompt("start a server");
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(session.harness.faux.state.callCount).toBe(3);
		expect(warned).toMatch(/still running:\n- bash-1 \(pid \d+/);
		expect(session.jobs.running()).toHaveLength(0);
	});

	it("holds again when the child answers the note without a report, and gives it the job's completion (B193)", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		// The first 1s hold ends with the job still running; the job ends 0.5s into the second.
		const session = await child({ jobHoldMs: 1000 });
		open.push(session);
		let warned = "";
		let last = "";
		session.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "sleep 1.5; echo slow-job-marker", background: true, reason: "suite" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("I'll wait for the completion message."),
			(context) => {
				warned = requestText(context);
				return fauxAssistantMessage("The job is still running, so I'll keep waiting.");
			},
			(context) => {
				last = requestText(context);
				return fauxAssistantMessage("done. The suite printed slow-job-marker.");
			},
		]);
		await session.harness.session.prompt("run the suite and report");
		expect(warned).toContain("end your turn without a report: the run holds again until one ends");
		expect(session.harness.faux.state.callCount).toBe(4);
		expect(last).toContain("slow-job-marker");
		expect(last).not.toMatch(/stopped[^\n]*run end/i);
		expect(session.jobs.running()).toHaveLength(0);
	});

	it("does not hold a top-level headless session's untimed job: it is stopped at run end as before", async () => {
		const session = await child({ isSubagent: false });
		open.push(session);
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", background: true, reason: "server" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
			fauxAssistantMessage("read the stop report"),
		]);
		const started = Date.now();
		await session.harness.session.prompt("start a server");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(session.jobs.running()).toHaveLength(0);
	});
});

describe.runIf(posix)("a subagent's own waits around its report (B744)", () => {
	const open: Array<{ harness: Harness; jobs: BashJobs }> = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const { harness, jobs } of open.splice(0)) {
			await jobs.stopAll("session end");
			harness.cleanup();
		}
	});
	const setWait = (after: number) =>
		fauxAssistantMessage([fauxToolCall("wait", { op: "set", after, note: "check the build", reason: "build" })], {
			stopReason: "toolUse",
		});
	const listWaits = async (session: { harness: Harness }) => {
		let listed = "";
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", { op: "list", all: true, reason: "check" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				listed = requestText(context);
				return fauxAssistantMessage("done. listed");
			},
		]);
		await session.harness.session.prompt("list waits");
		return listed;
	};

	it("ends the waits a child set when it reports: the run ends at once and no wake starts a turn later", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		session.harness.setResponses([setWait(1), fauxAssistantMessage("done. The build is green.")]);
		const started = Date.now();
		await session.harness.session.prompt("build and report");
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(session.harness.faux.state.callCount).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(session.harness.faux.state.callCount).toBe(2);
		const listed = await listWaits(session);
		expect(listed).toMatch(/cancel/i);
		expect(listed).not.toMatch(/\bactive\b/i);
	});

	it("keeps a wait the child answers without a report: the run holds and the wake starts its next turn", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		session.harness.setResponses([
			setWait(1),
			fauxAssistantMessage("Waiting for the build."),
			fauxAssistantMessage("done. The build is green."),
		]);
		await session.harness.session.prompt("build and report");
		expect(session.harness.faux.state.callCount).toBe(3);
	});

	it("leaves a top-level headless session's waits alone: its run still holds for the wake after a report-like answer", async () => {
		const session = await child({ isSubagent: false });
		open.push(session);
		session.harness.setResponses([
			setWait(1),
			fauxAssistantMessage("done. Reminder set."),
			fauxAssistantMessage("done. Reminded."),
		]);
		await session.harness.session.prompt("remind me");
		expect(session.harness.faux.state.callCount).toBe(3);
	});
});

describe("the report of a child held for its own job", () => {
	it("keeps the answer to the job's completion as a follow-up section, not glued to the answer before it", () => {
		const report = new ReportTracker();
		report.answer("I'll wait for the completion message.", "stop");
		report.incoming("custom", "bash-1 exited 0 after 1s", true);
		report.answer("done: the suite passed", "stop");
		const { text, outcome } = report.result();
		expect(text).not.toContain("message.done:");
		expect(text).toMatch(
			/I'll wait[\s\S]*Follow-up to the report above \(bash-1 exited 0 after 1s\):\ndone: the suite passed/,
		);
		expect(outcome).toBe("done");
	});

	it("adds only the job's line when no turn follows it", () => {
		const report = new ReportTracker();
		report.answer("done: started the server", "stop");
		report.incoming("custom", "bash-1 stopped (run end)", true);
		expect(report.result().text).toMatch(/done: started the server\n\nAfter this report: bash-1 stopped \(run end\)$/);
	});
});

describe("a deliberate foreground wait on a command that never exits by itself", () => {
	it("moves `tail -f | grep -m1` to the background at the long-command threshold instead of waiting out its timeout", () => {
		const plan = foregroundPlan(
			{ command: "tail -n +1 -f run.log | grep -m1 'e2e exit'", background: false, timeout: 3000 },
			90,
			{},
		);
		expect(plan).toMatchObject({ deliberate: false, auto: true, timeout: 30 });
		for (const command of [
			"tail -F app.log",
			"tail --follow=name app.log",
			"journalctl -f -u web",
			"kubectl logs -f pod/web",
		])
			expect(foregroundPlan({ command, background: false, timeout: 600 }, 90, {}).auto).toBe(true);
	});

	it("still honours a deliberate wait on an ordinary command, and a plain tail", () => {
		expect(foregroundPlan({ command: "make all", background: false, timeout: 600 }, 90, {})).toMatchObject({
			deliberate: true,
			auto: false,
		});
		for (const command of ["tail -n 50 app.log", "tail -n 5 a.log && grep -f patterns b.log", "yarn watch-docs"])
			expect(foregroundPlan({ command, background: false, timeout: 600 }, 90, {}).deliberate).toBe(true);
	});
});
