import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { jobNotice, ReportTracker } from "../../src/octocode/subagents/report.ts";
import { JOB_TYPE } from "../../src/octocode/shared/messages.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const NOTICE = "Background bash 1 finished after 4m00s: yarn build";

beforeAll(() => {
	const root = tmp("octocode-follow-up-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

describe("one task, one report", () => {
	it("folds the answer to the child's own job notice into the report as a follow-up, keeping its outcome", () => {
		const report = new ReportTracker();
		report.incoming("user");
		report.answer("done: all checks pass", "stop");
		report.incoming("custom", NOTICE);
		report.answer("The build finished cleanly.", "stop");
		expect(report.result()).toMatchObject({
			outcome: "done",
			outcomeSource: "first",
			text: `done: all checks pass\n\n---\n\nFollow-up to the report above (${NOTICE}):\nThe build finished cleanly.`,
		});
	});

	it("adds a line for a job that ended after the final answer without a turn, and keeps the outcome", () => {
		const report = new ReportTracker();
		report.incoming("user");
		report.answer("done: all checks pass", "stop");
		const notice = jobNotice({
			customType: JOB_TYPE,
			content: `[exit 0 · 14s · 1 line · 3 B · log: /tmp/b.log]\n${NOTICE}\nok`,
			details: { id: "bash-1", log: "/tmp/b.log", quiet: true },
		});
		expect(notice).toEqual({ job: `${NOTICE} (log: /tmp/b.log)`, quiet: true });
		report.incoming("custom", notice.job, notice.quiet);
		expect(report.result()).toMatchObject({
			outcome: "done",
			text: `done: all checks pass\n\nAfter this report: ${NOTICE} (log: /tmp/b.log)`,
		});
		// A job report that starts a turn is still read from its `Background bash` line.
		expect(jobNotice({ customType: JOB_TYPE, content: `[exit 0]\n${NOTICE}`, details: {} })).toEqual({ job: NOTICE });
		expect(jobNotice({ customType: "other", content: NOTICE })).toEqual({});
	});

	it("ignores a quiet job report that arrives before the first answer: the child read it, the report is unchanged", () => {
		const report = new ReportTracker();
		report.incoming("user");
		report.incoming("custom", `${NOTICE} (log: /tmp/b.log)`, true);
		report.answer("done: all checks pass", "stop");
		expect(report.result()).toMatchObject({ outcome: "done", text: "done: all checks pass" });
	});

	it("lets a follow-up that names an outcome change it, and judges a new task from the parent on its own", () => {
		const failed = new ReportTracker();
		failed.answer("done: all checks pass", "stop");
		failed.incoming("custom", NOTICE);
		failed.answer("failed: the build broke", "stop");
		expect(failed.result().outcome).toBe("failed");
		const steered = new ReportTracker();
		steered.answer("done: all checks pass", "stop");
		steered.incoming("custom");
		steered.answer("Checked the other condition too.", "stop");
		expect(steered.result().outcome).toBeUndefined();
		expect(steered.result().text).not.toContain("Follow-up to the report above");
	});

	it("delivers one background report with the follow-up attached, still reported done", async () => {
		const f = fakeHost();
		const team = new Team(f.api);
		const control = registerAgentTool(f.api, () => new Map(), team, fakePermission("full"));
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		try {
			const started = await f.tools
				.get("agent")
				.execute("call", { task: "job follow-up", goal: "build", background: true }, undefined, undefined, ctx);
			await control.settle();
			const reports = f.sent.filter((entry) => entry.message.customType === "octocode-agent-result");
			expect(reports).toHaveLength(1);
			const text = String(reports[0].message.content);
			expect(text).toContain(`Background subagent ${started.details.id} (general: build) reported done`);
			expect(text).toContain(
				`Follow-up to the report above (${NOTICE}):\nThe build finished cleanly; nothing changes.`,
			);
			expect(reports[0].message.details.outcome).toBe("done");
		} finally {
			await control.stopAll();
			team.stop();
		}
	});

	it("reads the job notice from the child's event stream", async () => {
		const outcome = await runSubagent(
			"job follow-up fails",
			[],
			tmp(),
			undefined,
			{ id: "a-0009" },
			undefined,
			() => undefined,
		);
		expect(outcome.text).toContain(`Follow-up to the report above (${NOTICE}):\nfailed: the build broke`);
		expect(outcome.outcome).toBe("failed");
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
