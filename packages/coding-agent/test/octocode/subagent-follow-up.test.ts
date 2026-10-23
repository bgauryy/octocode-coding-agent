import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-pi.cjs");
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
	fs.copyFileSync(FIXTURE, path.join(bin, "pi"));
	process.argv[1] = path.join(bin, "pi");
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
		const f = fakePi();
		const team = new Team(f.pi);
		const control = registerAgentTool(f.pi, () => new Map(), team, fakePermission("full"));
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
