import { describe, expect, it } from "vitest";
import { jobs } from "../../../db/src/api.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** RFC V2: an identical running background job is joined, never run twice; owners stay the only authority to signal. */

const until = async (check: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

/** One Octocode session: its own tool, jobs and message log, over the shared database. */
const session = (id: string, cwd: string) => {
	const { api, tools, sent } = fakeHost();
	const bashJobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), bashJobs, () => ({}));
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => id;
	const run = (params: Record<string, unknown>) =>
		tools.get("bash").execute("t", { reason: "Run it.", ...params }, undefined, undefined, ctx);
	return { run, bashJobs, sent };
};

const text = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text).join("\n");
const SLEEP = "sleep 60";

describe.runIf(process.platform !== "win32")("background bash joins", () => {
	it("joins an identical running job of another session, wakes for its end, and never signals it", async () => {
		const cwd = tmp();
		const first = session("s-first", cwd);
		const second = session("s-second", cwd);
		const started = await first.run({ command: SLEEP, background: true });
		expect(started.structuredContent).toMatchObject({ job: "bash-1" });

		// Spacing and a repeated space do not make a different command.
		const joined = await second.run({ command: `  sleep   60 `, background: true });
		expect(text(joined)).toMatch(/^joined bash-1 \(running \d+s?, log [^)]+\)/);
		expect(joined.structuredContent).toMatchObject({ job: "bash-1", joined: true });
		expect(second.bashJobs.jobs.size).toBe(0);

		// The joiner holds no signal over the other session's job: its own `stop` finds nothing to stop.
		expect(second.bashJobs.stop("bash-1", "user")).toBe(false);
		expect(first.bashJobs.jobs.has("bash-1")).toBe(true);

		// A different command, or the same one in another folder, starts its own run.
		expect(text(await second.run({ command: "sleep 61", background: true }))).not.toMatch(/^joined/);
		expect(second.bashJobs.jobs.size).toBe(1);

		// Its end wakes the joiner like a job of its own.
		expect(first.bashJobs.stop("bash-1", "user")).toBe(true);
		await until(() => second.sent.some((entry) => String(entry.message.content).includes("bash-1")));
		const report = second.sent.find((entry) => String(entry.message.content).includes("bash-1"))!;
		expect(String(report.message.content)).toContain("You joined this job");
		second.bashJobs.stop("bash-1", "user");
	});

	it("starts a new run with fresh: true, and never joins a finished job or a foreground call", async () => {
		const cwd = tmp();
		const first = session("s-one", cwd);
		const second = session("s-two", cwd);
		await first.run({ command: SLEEP, background: true });
		const fresh = await second.run({ command: SLEEP, background: true, fresh: true });
		expect(fresh.structuredContent).toMatchObject({ job: "bash-1" });
		expect(second.bashJobs.jobs.size).toBe(1);

		// A foreground call runs the command itself.
		const foreground = await second.run({ command: "echo hi" });
		expect(text(foreground)).toContain("hi");

		// Once the first run ended, the row says so and a new start is not a join.
		first.bashJobs.stop("bash-1", "user");
		second.bashJobs.stop("bash-1", "user");
		const rows = () =>
			jobs.running(sharedAgentDb().db, jobs.bySessionJob(sharedAgentDb().db, "s-one", "bash-1")!.workspace_id);
		await until(() => rows().length === 0);
		const again = await second.run({ command: SLEEP, background: true });
		expect(text(again)).not.toMatch(/^joined/);
		second.bashJobs.stop("bash-2", "user");
	});

	it("does not join a row whose owner record is gone, whatever the row says", async () => {
		const cwd = tmp();
		const first = session("s-live", cwd);
		const second = session("s-ghost", cwd);
		await first.run({ command: SLEEP, background: true });
		const row = jobs.bySessionJob(sharedAgentDb().db, "s-live", "bash-1")!;
		// A row naming a pid the owner record does not confirm grants no join.
		sharedAgentDb().db.prepare("UPDATE jobs SET pid = pid + 1 WHERE id = ?").run(row.id);
		expect(text(await second.run({ command: SLEEP, background: true }))).not.toMatch(/^joined/);
		first.bashJobs.stop("bash-1", "user");
		second.bashJobs.stop("bash-1", "user");
	});
});
