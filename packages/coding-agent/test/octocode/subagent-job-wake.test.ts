import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { JOB_TYPE } from "../../src/octocode/shared/messages.ts";
import { jobNotice } from "../../src/octocode/subagents/report.ts";
import { tmp } from "./helpers.ts";
import { blockingTool, count, createRig, pendingWakes, type Rig } from "./loop-characterization/rig.ts";

const sessions: { rig: Rig; jobs: BashJobs }[] = [];

afterEach(async () => {
	for (const { rig, jobs } of sessions.splice(0)) {
		await jobs.stopAll("run end");
		await rig.harness.session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		rig.cleanup();
	}
	vi.unstubAllEnvs();
});

async function session(subagent: boolean, mode: "tui" | "print" = "print") {
	vi.stubEnv(SUBAGENT_ENV, subagent ? "1" : "0");
	const jobs = new BashJobs(tmp());
	const hold = blockingTool();
	const rig = await createRig({
		mode,
		tools: [hold.tool],
		settings: { runtime: { eventWindowSeconds: 1 } },
		register: (api) => void registerBashTool(api, undefined, jobs),
	});
	sessions.push({ rig, jobs });
	const releaseJobs = () => writeFile(join(rig.ctx.cwd, "release-jobs"), "");
	return { rig, jobs, hold, releaseJobs };
}

// Release from the test only after the model has reached the boundary under examination.
const build = (name: string) =>
	fauxToolCall("bash", {
		command: `while [ ! -f release-jobs ]; do sleep 0.05; done; echo ${name}`,
		background: true,
		reason: `Build ${name}`,
	});

const reports = (rig: Rig) =>
	rig.harness.session.messages.filter((message) => message.role === "custom" && message.customType === JOB_TYPE);

it.each([true, false])(
	"records a job completed during a tool step before the final answer (subagent=%s)",
	async (child) => {
		const { rig, jobs, hold, releaseJobs } = await session(child);
		rig.harness.setResponses([
			fauxAssistantMessage(build("first"), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall(hold.tool.name, {}), { stopReason: "toolUse" }),
			rig.reply("final answer"),
			rig.reply("unexpected extra request"),
		]);
		const run = rig.harness.session.prompt("build then wait");
		await hold.started;
		try {
			const [job] = jobs.running();
			expect(job.id).toBe("bash-1");
			await releaseJobs();
			await job.done;
			// The session has the completion and shows it as the wake about to continue the run.
			if (!child) await vi.waitFor(() => expect(pendingWakes(rig)).toHaveLength(1));
		} finally {
			hold.release();
		}
		await run;
		await rig.harness.session.waitForIdle();
		expect(rig.harness.faux.state.callCount).toBe(3);
		expect(rig.harness.getPendingResponseCount()).toBe(1);
		const report = reports(rig)[0];
		expect(reports(rig)).toHaveLength(1);
		expect(report).toMatchObject({ details: { id: "bash-1" } });
		if (report?.role !== "custom") throw new Error("Missing bash report");
		const notice = jobNotice(report);
		expect(notice.job).toContain("Background bash bash-1");
		if (child) expect(notice.quiet).toBe(true);
		else {
			expect(notice.quiet).toBeUndefined();
			expect(count(rig.requests[0], "Background bash bash-1")).toBe(1);
		}
	},
);

it.each(["tui", "print"] as const)("wakes an idle %s session once with both bash results", async (mode) => {
	const { rig, jobs, releaseJobs } = await session(false, mode);
	rig.harness.setResponses([
		fauxAssistantMessage([build("first"), build("second")], { stopReason: "toolUse" }),
		rig.reply("both started"),
		rig.reply("both finished"),
		rig.reply("unexpected extra wake"),
	]);
	await rig.harness.session.prompt("build both in the background");
	await rig.harness.session.waitForIdle();
	expect(rig.ctx.hasUI).toBe(mode === "tui");
	expect(jobs.jobs.size).toBe(2);
	expect(rig.requests).toHaveLength(1);
	await releaseJobs();
	await vi.waitFor(() => expect(rig.requests).toHaveLength(2));
	await rig.harness.session.waitForIdle();
	for (const id of ["bash-1", "bash-2"]) expect(count(rig.requests[1], `Background bash ${id}`)).toBe(1);
	expect(reports(rig)).toHaveLength(2);
	expect(rig.harness.faux.state.callCount).toBe(3);
	expect(rig.harness.getPendingResponseCount()).toBe(1);
});
