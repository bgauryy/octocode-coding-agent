import { describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { agentNameOf } from "../../src/octocode/shared/agent-name.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** The commands the bash tool runs carry who runs them, so the full-run lock they take names its owner (RFC V3). */

const until = async (check: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const setup = () => {
	const { api, tools, sent } = fakeHost();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), jobs, () => ({}));
	agentNameOf(api).set("swift-orca");
	return { tool: tools.get("bash"), jobs, sent, ctx: fakeCtx({ cwd: tmp() }) };
};

const ECHO = 'echo "agent=$OCTOCODE_AGENT_NAME item=$OCTOCODE_ITEM job=$OCTOCODE_JOB_ID"';
const text = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text).join("\n");

describe.runIf(process.platform !== "win32")("bash owner environment", () => {
	it("names the agent and item to a foreground command, with no job", async () => {
		const { tool, ctx } = setup();
		const result = await tool.execute(
			"t1",
			{ command: ECHO, item: "B915", reason: "Show the owner." },
			undefined,
			undefined,
			ctx,
		);
		expect(text(result)).toContain("agent=swift-orca item=B915 job=\n");
	});

	it("names the agent, item and job to a background command", async () => {
		const { tool, sent, ctx } = setup();
		await tool.execute(
			"t1",
			{ command: ECHO, background: true, item: "B915", reason: "Show the owner." },
			undefined,
			undefined,
			ctx,
		);
		await until(() => sent.length === 1);
		expect(String(sent[0].message.content)).toContain("agent=swift-orca item=B915 job=bash-1");
	});

	it("does not pass on names a caller's own environment carried", async () => {
		const { tool, ctx } = setup();
		process.env.OCTOCODE_JOB_ID = "bash-99";
		try {
			const result = await tool.execute("t1", { command: ECHO, reason: "Show the owner." }, undefined, undefined, ctx);
			expect(text(result)).toContain("agent=swift-orca item= job=\n");
		} finally {
			delete process.env.OCTOCODE_JOB_ID;
		}
	});
});
