import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { JOB_TYPE } from "../../src/octocode/shared/messages.ts";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { jobNotice } from "../../src/octocode/subagents/report.ts";
import { createHarness, getAssistantTexts, type Harness } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";

const harnesses: Harness[] = [];
const savedSubagent = process.env[SUBAGENT_ENV];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	if (savedSubagent === undefined) delete process.env[SUBAGENT_ENV];
	else process.env[SUBAGENT_ENV] = savedSubagent;
});

/**
 * A real session: the model starts a background job, keeps working (a tool that outlasts the job), and gives its final
 * answer after the job already ended. The last scripted reply is only consumed if the job's report starts another turn.
 */
async function run(subagent: boolean) {
	if (subagent) process.env[SUBAGENT_ENV] = "1";
	else delete process.env[SUBAGENT_ENV];
	const jobs = new BashJobs(tmp());
	const outlast: AgentTool = {
		name: "outlast",
		label: "Outlast",
		description: "Returns once every background job has ended and reported",
		parameters: Type.Object({}),
		execute: async () => {
			const end = Date.now() + 10_000;
			while (jobs.jobs.size > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { content: [{ type: "text", text: "waited" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [outlast],
		features: testFeatures([(api) => void registerBashTool(api, undefined, jobs)]),
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", { command: "sleep 0.2; echo built", background: true, reason: "build it" }),
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage(fauxToolCall("outlast", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("final answer"),
		fauxAssistantMessage("woken by the job report"),
	]);
	await harness.session.prompt("start a build and report");
	const job = harness.session.messages.find((m) => m.role === "custom" && m.customType === JOB_TYPE);
	return { harness, job };
}

describe("a subagent's own background job", () => {
	it("is recorded without starting another model turn when it ends before the final answer", async () => {
		const { harness, job } = await run(true);
		expect(getAssistantTexts(harness)).toContain("final answer");
		expect(getAssistantTexts(harness)).not.toContain("woken by the job report");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(job).toMatchObject({ details: { id: "bash-1", quiet: true } });
		// The parent's report tracker turns it into the `After this report:` line.
		expect(jobNotice(job as never)).toMatchObject({
			quiet: true,
			job: expect.stringContaining("Background bash bash-1"),
		});
	});

	it("still wakes an interactive or print session once for the job report", async () => {
		const { harness, job } = await run(false);
		expect(getAssistantTexts(harness)).toContain("woken by the job report");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect((job as unknown as { details: Record<string, unknown> }).details.quiet).toBeUndefined();
	});
});
