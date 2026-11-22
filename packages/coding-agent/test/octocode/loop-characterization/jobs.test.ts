import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { BashJobs } from "../../../src/octocode/files/bash-jobs.ts";
import { registerAsyncJobs } from "../../../src/octocode/jobs/register.ts";
import { runBudgeted } from "../../../src/octocode/jobs/tool.ts";
import { JOB_TYPE, TASK_TYPE } from "../../../src/octocode/shared/messages.ts";
import { registerBashTool } from "../../../src/octocode/native/tools/bash/tool.ts";
import { blockingTool, count, createRig, type Rig } from "./rig.ts";
import { tmp } from "../helpers.ts";

/**
 * Characterization of the job producers (RFC agent-event-loop R0, §4): an own background `bash` job's exit and an async
 * `task-N` job (a tool call that outlived its foreground budget). Both report through the gate with
 * `{ triggerTurn, deliverAs: "followUp", together: true }`: native/tools/bash/tool.ts:116-134 and jobs/register.ts:30-37.
 * R6 moves these to `job.exit` topics; the asserted behaviour must survive it.
 */

const rigs: Rig[] = [];
const savedSubagent = process.env[SUBAGENT_ENV];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
	if (savedSubagent === undefined) delete process.env[SUBAGENT_ENV];
	else process.env[SUBAGENT_ENV] = savedSubagent;
});

const bashCall = (command: string) =>
	fauxAssistantMessage(fauxToolCall("bash", { command, background: true, reason: "characterize" }), {
		stopReason: "toolUse",
	});

async function bashRig(subagent: boolean) {
	if (subagent) process.env[SUBAGENT_ENV] = "1";
	else delete process.env[SUBAGENT_ENV];
	const jobs = new BashJobs(tmp());
	const slow = blockingTool("hold");
	const rig = await createRig({
		tools: [slow.tool],
		register: (api) => void registerBashTool(api, undefined, jobs),
	});
	rigs.push(rig);
	return { rig, jobs, slow };
}

const jobMessages = (rig: Rig) =>
	rig.harness.session.messages.filter((message) => message.role === "custom" && message.customType === JOB_TYPE);

describe("an own background bash job's exit", () => {
	it("wakes an idle interactive session: one turn that carries the report (follow-up, together)", async () => {
		const { rig, jobs } = await bashRig(false);
		rig.harness.setResponses([bashCall("echo built"), fauxAssistantMessage("started"), rig.reply("woken by the job")]);
		await rig.harness.session.prompt("build in the background");
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "Background bash bash-1")).toBe(1);
		expect(jobMessages(rig)).toHaveLength(1);
		expect(jobMessages(rig)[0]).toMatchObject({ details: { id: "bash-1" } });
		expect(jobs.jobs.size).toBe(0);
	});

	it("wakes for a failing job too, with the same single turn", async () => {
		const { rig } = await bashRig(false);
		rig.harness.setResponses([bashCall("exit 3"), fauxAssistantMessage("started"), rig.reply("saw the failure")]);
		await rig.harness.session.prompt("run a failing job");
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "bash-1")).toBeGreaterThan(0);
		expect(JSON.stringify(jobMessages(rig)[0])).toContain("3");
	});

	it("queued as a follow-up when it ends mid-run: its turn comes after the final answer, not inside the run", async () => {
		const { rig, jobs, slow } = await bashRig(false);
		rig.harness.setResponses([
			bashCall("echo built"),
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			rig.reply("final answer"),
			rig.reply("woken by the job report"),
		]);
		const running = rig.harness.session.prompt("build then wait");
		await slow.started;
		await vi.waitFor(() => expect(jobs.jobs.size).toBe(0), { timeout: 10_000 });
		slow.release();
		await running;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(2), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "Background bash bash-1")).toBe(0);
		expect(count(rig.requests[1], "Background bash bash-1")).toBe(1);
	});

	it("in a subagent is recorded quietly and starts no turn", async () => {
		const { rig, jobs, slow } = await bashRig(true);
		rig.harness.setResponses([
			bashCall("echo built"),
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
			fauxAssistantMessage("must not be consumed"),
		]);
		const running = rig.harness.session.prompt("build then wait");
		await slow.started;
		await vi.waitFor(() => expect(jobs.jobs.size).toBe(0), { timeout: 10_000 });
		slow.release();
		await running;
		await rig.harness.session.waitForIdle();
		expect(rig.harness.getPendingResponseCount()).toBe(1);
		expect(jobMessages(rig)[0]).toMatchObject({ details: { id: "bash-1", quiet: true } });
	});
});

/** A tool whose work outlives its foreground budget and becomes `task-1` (jobs/tool.ts:33). */
function taskTool(work: Promise<string>) {
	return (api: Parameters<typeof registerAsyncJobs>[0]) => {
		registerAsyncJobs(api);
		api.tools.register({
			name: "slowweb",
			label: "slowweb",
			description: "A call that becomes a job",
			parameters: Type.Object({}),
			async execute(_id, _args, signal, _onUpdate, ctx) {
				return runBudgeted(
					{ session: ctx.sessionManager, tool: "web", title: "fetch", signal, foregroundMs: 5 },
					async () => ({
						content: [{ type: "text" as const, text: await work }],
						details: undefined,
					}),
				);
			},
		});
	};
}

describe("an async task-N job's exit", () => {
	it("returns its id to the call, then wakes the idle session once with the result", async () => {
		let finish = (_text: string) => {};
		const work = new Promise<string>((resolve) => (finish = resolve));
		const rig = await createRig({ register: taskTool(work) });
		rigs.push(rig);
		rig.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slowweb", {}), { stopReason: "toolUse" }),
			rig.reply("started task-1"),
			rig.reply("woken by task-1"),
		]);
		await rig.harness.session.prompt("fetch it");
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "task-1")).toBeGreaterThan(0);
		expect(rig.requests).toHaveLength(1);
		finish("RESULT-OF-THE-FETCH");
		await vi.waitFor(() => expect(rig.requests).toHaveLength(2), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[1], "RESULT-OF-THE-FETCH")).toBe(1);
		const reports = rig.harness.session.messages.filter((m) => m.role === "custom" && m.customType === TASK_TYPE);
		expect(reports).toHaveLength(1);
	});

	it("a stopped job (session end) is recorded and starts no turn", async () => {
		const work = new Promise<string>(() => {});
		const rig = await createRig({ register: taskTool(work) });
		rigs.push(rig);
		rig.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slowweb", {}), { stopReason: "toolUse" }),
			rig.reply("started task-1"),
			rig.reply("must not be consumed"),
		]);
		await rig.harness.session.prompt("fetch it");
		await rig.harness.session.waitForIdle();
		await rig.harness.session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(rig.requests).toHaveLength(1);
		expect(rig.harness.getPendingResponseCount()).toBe(1);
	});
});
