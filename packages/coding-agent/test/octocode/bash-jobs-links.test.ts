import { describe, expect, it, vi } from "vitest";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { jobLinks } from "../../src/octocode/backlog/job-links.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

// The host's real lock record is not read: the test names its holder.
vi.mock("../../src/octocode/graph/run-lock.ts", () => ({
	readRunLockSnap: () => ({ label: "yarn run check", agent: "swift-orca", item: "B915", job: "bash-1" }),
}));

describe.runIf(process.platform !== "win32")("/jobs links", () => {
	it("names the item a job serves and the full-run lock it holds", async () => {
		const { api, tools } = fakeHost();
		const commands = new Subcommands();
		const jobs = new BashJobs(tmp());
		registerBashTool(api, commands, jobs, () => ({}), jobLinks);
		const ctx = fakeCtx({ cwd: tmp() });
		const { store } = openBacklog(ctx, { isSubagent: false });
		const item = store.add({
			title: "Checked work",
			goal: "Expected",
			why: "Needed",
			state: "todo",
			createdBy: "user",
		});
		const other = tools.get("bash");
		await other.execute(
			"t",
			{ command: "sleep 30", background: true, item: item.ref, reason: "Run the check." },
			undefined,
			undefined,
			ctx,
		);
		await other.execute(
			"t",
			{ command: "sleep 31", background: true, reason: "Unrelated." },
			undefined,
			undefined,
			ctx,
		);
		await commands.get("jobs")!.handler("", ctx);
		const text = ctx.ui.notes.at(-1)!.message;
		const lines = text.split("\n");
		expect(lines.find((line) => line.startsWith("bash-1"))).toMatch(
			new RegExp(`sleep 30 · item ${item.ref} · holds full-run$`),
		);
		// The lock names job bash-1 only: the other job holds nothing and serves nothing.
		expect(lines.find((line) => line.startsWith("bash-2"))).toMatch(/sleep 31$/);
		jobs.stop("bash-1", "user");
		jobs.stop("bash-2", "user");
	});
});
