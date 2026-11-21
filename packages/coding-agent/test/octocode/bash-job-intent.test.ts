import { describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { renderJobMessage } from "../../src/octocode/files/render.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { withReason } from "../../src/octocode/shared/reason.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A job is work with no backlog item: its command says what it does, and the call's `reason` why it runs. */

const until = async (check: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const setup = (shell: { backgroundAfterSeconds?: number } = {}) => {
	const { api, tools, sent, fire } = fakeHost();
	const commands = new Subcommands();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, commands, jobs, () => shell);
	const cwd = tmp();
	return { tool: tools.get("bash"), commands, jobs, sent, fire, ctx: fakeCtx({ cwd }) };
};

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as never;

describe.runIf(process.platform !== "win32")("background job intent", () => {
	it("declares reason itself, and registration moves its own definition first", () => {
		const { tool } = setup();
		expect(tool.parameters.required).toEqual(["command", "reason"]);
		const first = withReason(tool.parameters);
		expect(Object.keys(first.properties)[0]).toBe("reason");
		expect(first.properties.reason).toEqual(tool.parameters.properties.reason);
		expect(first.required).toEqual(["command", "reason"]);
	});

	it("reports why the job ran, and /jobs lists it", async () => {
		const { tool, commands, jobs, sent, ctx } = setup();
		const reason = "Run the full suite while I review the diff.";
		await tool.execute("t1", { command: "sleep 0.3; echo done", background: true, reason }, undefined, undefined, ctx);
		expect(jobs.jobs.get("bash-1")!.reason).toBe(reason);
		await commands.get("jobs")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`why: ${reason}`);
		await until(() => sent.length === 1);
		const report = String(sent[0].message.content);
		// The text the model reads does not repeat the why it gave; the details carry it for the row.
		expect(report).toMatch(/Background bash bash-1 finished: sleep 0\.3; echo done/);
		expect(report).not.toContain(reason);
		const details = sent[0].message.details;
		expect(details).toMatchObject({ id: "bash-1", ok: true, how: "finished", why: reason });
		const lines = renderJobMessage(report, false, plainTheme, 1, details).render(120).join("\n");
		expect(lines).toContain(`↳ ${reason}`);
		expect(lines).toContain("bash-1: sleep 0.3; echo done");
		expect(lines).toMatch(/finished after \d/);
		expect(lines).not.toContain("Why:");
		// A report saved before the details existed still renders from its text.
		const old =
			"[exit 0 · 3s · log: a.log]\nBackground bash bash-1 finished after 3s: yarn build\nWhy: Run the full suite\nok";
		const legacy = renderJobMessage(old, false, plainTheme).render(120).join("\n");
		expect(legacy).toContain("↳ Run the full suite");
		expect(legacy).toContain("bash-1: yarn build");
	});

	it("keeps the why of a foreground command that moved to the background", async () => {
		// The threshold moves it: a call with its own timeout is stopped then instead (RFC core-tools B1).
		const { tool, jobs, ctx } = setup({ backgroundAfterSeconds: 1 });
		const reason = "Wait for the dev server to settle.";
		await tool.execute("t1", { command: "echo up; sleep 30", reason }, undefined, undefined, ctx);
		expect(jobs.jobs.get("bash-1")!.reason).toBe(reason);
		await jobs.stopAll("session end");
	});

	it("names the why of jobs a /reload stopped", async () => {
		const { tool, fire, ctx, jobs } = setup();
		await tool.execute(
			"t1",
			{ command: "sleep 30", background: true, reason: "Watch the build." },
			undefined,
			undefined,
			ctx,
		);
		await fire("session_shutdown", { reason: "reload" }, ctx);
		const next = fakeHost();
		registerBashTool(next.api, new Subcommands(), new BashJobs(jobs.logDir()), () => ({}));
		const fresh = fakeCtx({ cwd: ctx.cwd });
		await next.fire("session_start", { reason: "reload" }, fresh);
		expect(fresh.ui.notes.map((note) => note.message).join("\n")).toMatch(
			/bash-1 · sleep 30\n {4}why: Watch the build\.\n {4}log: /,
		);
	});
});
