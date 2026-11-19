import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { RERUN_HINT } from "../../src/octocode/files/outcome.ts";
import { recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { groupAlive, processAlive } from "../../src/octocode/shared/process.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import {
	DEFAULT_BASH_TIMEOUT,
	effectiveTimeout,
	MAX_FOREGROUND_TIMEOUT,
	orphanNotice,
} from "../../src/octocode/files/bash/results.ts";
import { jobReport } from "../../src/octocode/files/bash-jobs/report.ts";
import { logTail } from "../../src/octocode/files/bash-jobs/tail.ts";
import { prefixed, type ShellSettings, shellSettings } from "../../src/octocode/files/bash-jobs/shell.ts";

const until = async (check: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

describe("bash deadline", () => {
	it("honours the timeout a call asks for, longer or shorter, up to an hour, and fills a missing one with 15 minutes", () => {
		expect(DEFAULT_BASH_TIMEOUT).toBe(900);
		expect(MAX_FOREGROUND_TIMEOUT).toBe(3600);
		expect(effectiveTimeout(undefined)).toEqual({ seconds: 900, clamped: false });
		expect(effectiveTimeout(30)).toEqual({ seconds: 30, clamped: false });
		expect(effectiveTimeout(3_600)).toEqual({ seconds: 3_600, clamped: false });
		expect(effectiveTimeout(0)).toEqual({ seconds: 900, clamped: false });
		expect(effectiveTimeout(-1)).toEqual({ seconds: 900, clamped: false });
		expect(effectiveTimeout(Number.NaN)).toEqual({ seconds: 900, clamped: false });
	});

	it("clamps a longer foreground timeout to an hour and says so", () => {
		expect(effectiveTimeout(3_601)).toEqual({ seconds: 3_600, clamped: true });
		expect(effectiveTimeout(1e6)).toEqual({ seconds: 3_600, clamped: true });
		expect(effectiveTimeout(Number.POSITIVE_INFINITY)).toEqual({ seconds: 900, clamped: false });
	});
});

describe("bash tool", () => {
	const setup = (shell: ShellSettings = {}) => {
		const { api, tools, commands: registered, sent, fire } = fakeHost();
		const commands = new Subcommands();
		const jobs = new BashJobs(tmp());
		registerBashTool(api, commands, jobs, () => shell);
		const cwd = tmp();
		const ctx = fakeCtx({ cwd });
		return { tool: tools.get("bash"), registered, commands, jobs, sent, fire, cwd, ctx, work: runningWorkOf(api) };
	};

	it("replaces Octocode bash with a schema that has background and a documented deadline", () => {
		const { tool } = setup();
		expect(tool.name).toBe("bash");
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"type",
			"command",
			"timeout",
			"maxOutputTokens",
			"background",
			"verify",
			"sandbox",
			"item",
			"reason",
		]);
		// Octocode's bash output, or a background start: codemode scripts get structuredContent only when this is declared.
		const [foreground, background] = tool.outputSchema.anyOf;
		expect(foreground.allOf).toHaveLength(2);
		expect(Object.keys(foreground.allOf[1].properties)).toEqual(["verification"]);
		expect(Object.keys(background.properties)).toEqual(["job", "pid", "log", "verification"]);
	});

	it("runs a foreground command in the session cwd and returns its output", async () => {
		const { tool, ctx, cwd } = setup();
		const result = await tool.execute("t1", { command: "pwd; echo hi" }, undefined, undefined, ctx);
		expect(result.content[0].text).toContain(fs.realpathSync(cwd));
		expect(result.content[0].text).toContain("hi");
	});

	it("records explicit foreground verification without treating an ordinary command as a check", async () => {
		const { tool, ctx, cwd } = setup();
		const plain = await tool.execute("plain", { command: "true" }, undefined, undefined, ctx);
		expect(plain.structuredContent.verification).toBeUndefined();
		const result = await tool.execute("check", { command: "exit 3", verify: true }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.structuredContent.verification).toMatchObject({
			command: "exit 3",
			cwd,
			sessionId: "session-test",
			state: "failed",
			exitCode: 3,
			stale: false,
			output: { complete: true },
		});
		expect(result.details.verification).toMatchObject(result.structuredContent.verification);
		expect(result.content[0].text).toContain("Verification: exit 3");
	});

	it("marks a background verification stale when a later agent edit commits before completion", async () => {
		const { tool, ctx, jobs, sent } = setup();
		const start = await tool.execute(
			"check",
			{ command: "sleep 0.3; exit 2", background: true, verify: true },
			undefined,
			undefined,
			ctx,
		);
		expect(start.structuredContent.verification).toMatchObject({ state: "running", output: { complete: false } });
		expect(start.content[0].text).not.toContain("Verification:");
		recordMutation("session-test");
		await until(() => sent.length === 1);
		expect(jobs.jobs.size).toBe(0);
		expect(sent[0].message.details.verification).toMatchObject({ state: "failed", exitCode: 2, stale: true });
		expect(sent[0].message.content).toContain("later agent edits invalidate this check");
		expect(sent[0].message.details.verification.output).toMatchObject({ complete: true, tailIncomplete: false });
	});

	it("keeps verification pending across a foreground handoff and reports the later failure once", async () => {
		const { tool, ctx, sent, jobs } = setup({ backgroundAfterSeconds: 1 });
		const handoff = await tool.execute(
			"check",
			{ command: "echo started; sleep 1.3; exit 4", verify: true },
			undefined,
			undefined,
			ctx,
		);
		expect(handoff.structuredContent.verification).toMatchObject({ state: "running", output: { complete: false } });
		expect(handoff.content[0].text).not.toContain("Verification:");
		await until(() => sent.length === 1);
		expect(sent[0].message.details.verification).toMatchObject({ state: "failed", exitCode: 4 });
		expect(jobs.jobs.size).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent).toHaveLength(1);
	});

	it("does not start a background command after its request was aborted", async () => {
		const { tool, ctx, jobs, cwd } = setup();
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(
				tool.execute(
					"cancel-background",
					{ command: "echo started > cancelled.txt", background: true },
					controller.signal,
					undefined,
					ctx,
				),
			).rejects.toThrow(/abort/i);
			expect(fs.existsSync(path.join(cwd, "cancelled.txt"))).toBe(false);
			expect(jobs.jobs.size).toBe(0);
		} finally {
			await jobs.stopAll("session end");
		}
	});

	it("stops a foreground sleep at its deadline and says how to run it longer", async () => {
		const { tool, ctx, jobs } = setup();
		const started = Date.now();
		await expect(tool.execute("t1", { command: "sleep 30", timeout: 1 }, undefined, undefined, ctx)).rejects.toThrow(
			/^\[timed out after 1s · [\s\S]*background: true/,
		);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(jobs.jobs.size).toBe(0);
	});

	it("moves any other foreground command that reaches the threshold to the background and says so", async () => {
		const { tool, ctx, jobs } = setup({ backgroundAfterSeconds: 1 });
		try {
			const result = await tool.execute("t1", { command: "echo before; sleep 30" }, undefined, undefined, ctx);
			const job = jobs.jobs.get("bash-1")!;
			expect(processAlive(job.pid)).toBe(true);
			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toMatch(
				new RegExp(
					`^before\\n\\nDid not finish within 1s; moved to the background as bash-1 \\(pid ${job.pid}\\)[^\\n]*\\nLog: .*bash-1-\\d+\\.log\\nCheck: tail -n 40 .*\\nStop: kill -- -${job.pid}\\n\\n\\(foreground commands move to the background after the configured threshold; pass a timeout [^\\n]*\\)$`,
				),
			);
			expect(result.details).toMatchObject({ job: "bash-1", pid: job.pid, log: job.log, moved: true });
			expect(result.structuredContent).toEqual({ job: "bash-1", pid: job.pid, log: job.log });
			expect(path.dirname(job.log)).toBe(jobs.logDir());
		} finally {
			await jobs.stopAll("session end");
		}
	});

	it("carries the clamp note on a command that failed for another reason: a non-zero exit, and an abort", async () => {
		const { tool, ctx } = setup();
		const failed = await tool.execute(
			"t1",
			{ command: "echo oops; exit 3", timeout: 1_000_000 },
			undefined,
			undefined,
			ctx,
		);
		expect(failed.content[0].text).toMatch(
			/^\[exit 3 · [\s\S]*oops[\s\S]*\(timeout clamped to 3600 s; use background: true for longer\)/,
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		await expect(
			tool.execute("t2", { command: "echo started; sleep 30", timeout: 1_000_000 }, controller.signal, undefined, ctx),
		).rejects.toThrow(/aborted[\s\S]*\(timeout clamped to 3600 s; use background: true for longer\)/);
		const plain = new AbortController();
		setTimeout(() => plain.abort(), 300);
		const message = await tool
			.execute("t3", { command: "sleep 30", timeout: 60 }, plain.signal, undefined, ctx)
			.catch((error: Error) => error.message);
		expect(message).toMatch(/aborted/);
		expect(message).not.toMatch(/clamped/);
	});

	it("states in the result that a foreground timeout above an hour was clamped, and says nothing otherwise", async () => {
		const { tool, ctx } = setup();
		const clamped = await tool.execute("t1", { command: "echo done", timeout: 1_000_000 }, undefined, undefined, ctx);
		expect(clamped.content[0].text).toContain("done");
		expect(clamped.content[0].text).toContain("(timeout clamped to 3600 s; use background: true for longer)");
		const plain = await tool.execute("t2", { command: "echo done", timeout: 3_600 }, undefined, undefined, ctx);
		expect(plain.content[0].text).not.toMatch(/clamped/);
		expect(tool.parameters.properties.timeout).not.toHaveProperty("maximum");
	});

	it("moves the full output of a truncated command out of the temp dir into its own folder", async () => {
		const { tool, ctx, jobs } = setup();
		const result = await tool.execute("t1", { command: "seq 1 5000" }, undefined, undefined, ctx);
		const saved = result.details.fullOutputPath as string;
		expect(path.dirname(saved)).toBe(jobs.logDir());
		expect(fs.readFileSync(saved, "utf8").split("\n")[4999]).toBe("5000");
		expect(result.content[0].text).toContain(`full output: ${saved}]`);
		// A failing command (Octocode returns it as an error result) points at the moved file too.
		const failed = await tool.execute("t2", { command: "seq 1 5000; exit 1" }, undefined, undefined, ctx);
		expect(failed.isError).toBe(true);
		const moved = failed.details.fullOutputPath as string;
		expect(path.dirname(moved)).toBe(jobs.logDir());
		expect(fs.existsSync(moved)).toBe(true);
		expect(failed.content[0].text).toContain(`full output: ${moved}]`);
	});

	it("moves the spill file of a command that timed out, though only its updates named it", async () => {
		const { tool, ctx, jobs } = setup();
		const message = await tool
			.execute("t1", { command: "sleep 0; seq 1 5000; sleep 30", timeout: 1 }, undefined, undefined, ctx)
			.catch((error: Error) => error.message);
		const moved = /full output: (.+?)\]/.exec(message)![1];
		expect(path.isAbsolute(moved), "a read tool takes the path as printed: no ~").toBe(true);
		expect(path.dirname(moved)).toBe(jobs.logDir());
		expect(fs.readFileSync(moved, "utf8")).toContain("5000");
	});

	it("names the moved spill file when a command that moved to the background had printed a lot", async () => {
		const { tool, ctx, jobs } = setup({ backgroundAfterSeconds: 1 });
		try {
			const result = await tool.execute("t1", { command: "seq 1 5000; sleep 30" }, undefined, undefined, ctx);
			const spill = result.details.fullOutputPath as string;
			expect(path.dirname(spill)).toBe(jobs.logDir());
			expect(result.content[0].text).toContain(`Output so far, in full: ${spill}`);
			expect(fs.readFileSync(spill, "utf8")).toContain("5000");
			// The job log starts with everything printed before the move.
			expect(fs.readFileSync(jobs.jobs.get("bash-1")!.log, "utf8")).toContain("5000");
		} finally {
			await jobs.stopAll("session end");
		}
	});

	it("runs foreground and background commands with the shellCommandPrefix and shellPath from Octocode settings", async () => {
		const { tool, ctx, sent } = setup({ commandPrefix: "export OCTO_PREFIX=set", shellPath: "/bin/sh" });
		const foreground = await tool.execute("t1", { command: 'echo "prefix=$OCTO_PREFIX"' }, undefined, undefined, ctx);
		expect(foreground.content[0].text).toContain("prefix=set");
		const result = await tool.execute(
			"t2",
			{ command: 'echo "prefix=$OCTO_PREFIX"', background: true },
			undefined,
			undefined,
			ctx,
		);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toContain("prefix=set");
		expect(result.content[0].text).toMatch(/Started bash-1/);
	});

	it("reads shell settings from Octocode settings files and survives unreadable ones", () => {
		expect(shellSettings(tmp(), false)).toEqual(expect.any(Object));
		expect(prefixed("ls", "set -e")).toBe("set -e\nls");
		expect(prefixed("ls")).toBe("ls");
	});

	it("keeps every rotated log within its cap when one chunk is larger than the cap", async () => {
		const jobs = new BashJobs(tmp());
		let exited = false;
		// One 40 KB burst of short lines, then one 20 KB line: both arrive in chunks larger than the 8 KB cap.
		const job = await jobs.start(
			'awk \'BEGIN { for (i = 0; i < 2000; i++) printf "line %05d padding\\n", i; s = sprintf("%20000s", ""); gsub(/ /, "x", s); print s; print "end" }\'',
			tmp(),
			undefined,
			() => {
				exited = true;
				return exited;
			},
			{ maxLogBytes: 8 * 1024 },
		);
		await until(() => exited);
		for (const file of [job.log, `${job.log}.1`]) expect(fs.statSync(file).size).toBeLessThanOrEqual(8 * 1024);
		expect(fs.readFileSync(job.log, "utf8")).toMatch(/end\n$/);
	});

	it("rotates a background job log at its cap without losing or reordering output", async () => {
		const jobs = new BashJobs(tmp());
		let exited = false;
		let exit: Parameters<typeof jobReport>[1] | undefined;
		const job = await jobs.start(
			'i=0; while [ $i -lt 3000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done',
			tmp(),
			undefined,
			(_job, done) => {
				exited = true;
				exit = done;
				return exit;
			},
			{ maxLogBytes: 8 * 1024 },
		);
		await until(() => exited);
		// The report to the model says the log rotated, where the older part is, and that older output than that is gone.
		expect(exit!.logRotations).toBeGreaterThan(1);
		expect(jobReport(job, exit!)).toContain(
			`log rotated at its size cap ${exit!.logRotations} times: ${job.log}.1 holds the part before this log; output before that was dropped and cannot be recovered`,
		);
		const log = fs.readFileSync(job.log, "utf8");
		const previous = fs.readFileSync(`${job.log}.1`, "utf8");
		expect(Buffer.byteLength(log)).toBeLessThanOrEqual(8 * 1024);
		expect(log).toMatch(
			new RegExp(`^\\[earlier output is in ${path.basename(job.log)}\\.1; older output was dropped\\]`),
		);
		// Whatever both files keep is one unbroken run of lines ending at the last one.
		const numbers = [...`${previous}${log}`.matchAll(/^line (\d+) /gm)].map((match) => Number(match[1]));
		expect(numbers.at(-1)).toBe(2999);
		expect(numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1)).toBe(true);
		expect(numbers.length).toBeGreaterThan(100);
	});

	it("keeps job logs in the current session folder under the Octocode home by default", () => {
		const home = tmp();
		const saved = process.env.OCTOCODE_HOME;
		process.env.OCTOCODE_HOME = home;
		try {
			expect(new BashJobs().logDir()).toBe(path.join(home, "agent", "sessions", `_pid-${process.pid}`, "bash"));
			setCurrentSession("s:1");
			expect(new BashJobs().logDir()).toBe(path.join(home, "agent", "sessions", "s_1", "bash"));
		} finally {
			setCurrentSession(undefined);
			if (saved === undefined) delete process.env.OCTOCODE_HOME;
			else process.env.OCTOCODE_HOME = saved;
		}
	});

	it("keeps the exit code of a failing foreground command", async () => {
		const { tool, ctx } = setup();
		// Octocode 0.99 returns a non-zero exit as an error result (with structured output) rather than throwing.
		const result = await tool.execute("t1", { command: "echo oops; exit 3" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/^\[exit 3 · [\d.]+s · 1 line · 5 B\]\noops/);
		expect(result.structuredContent.exit_code).toBe(3);
	});

	it("fails a git editor at once with guidance instead of waiting for input, in the foreground and the background", async () => {
		const { tool, ctx, cwd, sent } = setup();
		const git = "git -c user.name=t -c user.email=t@t -c commit.gpgsign=false";
		const repo = `git init -q && ${git} commit -q --allow-empty -m init && echo x > f && git add f`;
		await tool.execute("t0", { command: repo }, undefined, undefined, ctx);
		const started = Date.now();
		const result = await tool.execute("t1", { command: `${git} commit`, timeout: 20 }, undefined, undefined, ctx);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No interactive editor in this shell");
		await tool.execute("t2", { command: `${git} commit`, background: true }, undefined, undefined, ctx);
		await until(() => sent.length === 1, 10_000);
		expect(sent[0].message.content).toMatch(/failed with exit code [1-9][\s\S]*No interactive editor/);
		// An editor named on the command line still wins, and pagers default to cat.
		const inline = await tool.execute(
			"t3",
			{
				command: `GIT_EDITOR=true ${git} commit -q --allow-empty-message && git log --oneline | wc -l; echo "$PAGER $GIT_PAGER"`,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(
			inline.content[0].text
				.replace(/^\[[^\n]*\]\n/, "")
				.trim()
				.split(/\s+/),
		).toEqual(["2", "cat", "cat"]);
		expect(fs.existsSync(path.join(cwd, ".git"))).toBe(true);
	});

	it("starts a background job at once and reports its exit and output tail as a follow-up message", async () => {
		const { tool, ctx, jobs, sent, work } = setup();
		const result = await tool.execute(
			"t1",
			{ command: "echo started; sleep 0.3; echo done; exit 2", background: true, reason: "check the exit code" },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[0].text as string;
		expect(text).toMatch(/^Started bash-1 in the background \(pid \d+\)/);
		expect(text).toMatch(/Stop: kill -- -\d+/);
		expect(result.structuredContent).toEqual({
			job: "bash-1",
			pid: expect.any(Number),
			log: expect.stringMatching(/bash-1-\d+\.log$/),
		});
		expect(jobs.jobs.size).toBe(1);
		// The job is a typed row (id, its reason first and the command after it, start time) for the footer and the work rows.
		expect(work.all()).toEqual([
			{
				kind: "bash",
				id: "bash-1",
				title: "check the exit code",
				detail: "echo started; sleep 0.3; echo done; exit 2",
				startedAt: expect.any(Number),
			},
		]);
		await until(() => sent.length === 1);
		expect(jobs.jobs.size).toBe(0);
		expect(work.all()).toEqual([]);
		const { message, options } = sent[0];
		expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp", together: true });
		expect(message.content).toMatch(
			/^\[exit 2 · [^\n]*\]\nBackground bash bash-1 failed with exit code 2 after \d+s: echo started/,
		);
		expect(message.content).toMatch(/started\ndone/);
	});

	it("caps a background timeout at the longest timer Node keeps instead of stopping the job at once", async () => {
		const { tool, ctx, jobs, sent } = setup();
		const result = await tool.execute(
			"t1",
			{ command: "sleep 0.3", background: true, timeout: 3_000_000 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toMatch(/will be stopped if still running after 596h31m/);
		expect(jobs.jobs.get("bash-1")?.timeout).toBe(2_147_483);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(jobs.jobs.size).toBe(1);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).not.toMatch(/stopped/);
	});

	it("gives a background job the environment Octocode gives a foreground command, with a private log", async () => {
		const { tool, ctx, sent } = setup();
		vi.stubEnv("OCTOCODE_MODEL", "stale-model");
		vi.stubEnv("OCTOCODE_SESSION_FILE", "/stale/session");
		vi.stubEnv("PATH", ["/usr/bin", "/bin"].join(path.delimiter));
		try {
			const command =
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell expansion is intentional.
				'printf "%s|%s|%s|%s" "$OCTOCODE_SESSION_ID" "${OCTOCODE_MODEL-unset}" "${OCTOCODE_SESSION_FILE-unset}" "$PATH"';
			const foreground = (await tool.execute("t0", { command }, undefined, undefined, ctx)).content[0].text as string;
			const result = await tool.execute("t1", { command, background: true }, undefined, undefined, ctx);
			await until(() => sent.length === 1);
			const log = /Log: (\S+)/.exec(result.content[0].text as string)![1];
			const background = fs.readFileSync(log, "utf8");
			expect(background).toBe(foreground.replace(/^\[[^\n]*\]\n/, "").trim());
			expect(background).toBe(
				`session-test|unset|unset|${[path.join(getAgentDir(), "bin"), "/usr/bin", "/bin"].join(path.delimiter)}`,
			);
			if (process.platform !== "win32") expect(fs.statSync(log).mode & 0o777).toBe(0o600);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("stops a background job at its own timeout", async () => {
		const { tool, ctx, sent } = setup();
		await tool.execute("t1", { command: "sleep 30", background: true, timeout: 1 }, undefined, undefined, ctx);
		await until(() => sent.length === 1, 8_000);
		expect(sent[0].message.content).toMatch(/stopped after its 1s timeout/);
	});

	it("lists and kills jobs with /jobs, and reports the ones session end stops without waking anyone", async () => {
		const { tool, ctx, commands, jobs, sent, fire } = setup();
		await tool.execute("t1", { command: "sleep 30", background: true }, undefined, undefined, ctx);
		await tool.execute("t2", { command: "sleep 30", background: true }, undefined, undefined, ctx);
		const [first, second] = [...jobs.jobs.values()];
		await commands.get("jobs")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(
			/bash-1 · \d+s · pid \d+ · sleep 30\n {2}log: .*bash-1-\d+\.log\nbash-2/,
		);
		expect(commands.complete("jobs kill ")?.map((item) => item.value)).toEqual([
			"jobs kill bash-1",
			"jobs kill bash-2",
		]);
		ctx.ui.confirms.push(true);
		await commands.get("jobs")!.handler("kill bash-1", ctx);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toMatch(/bash-1 stopped \(user\)/);
		expect(processAlive(first.pid)).toBe(false);
		await commands.get("jobs")!.handler("kill nope", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/No background bash job "nope"/);
		expect(sent[0].message.details).toEqual({ id: "bash-1", command: "sleep 30", log: first.log, quiet: true });
		// The user stopped it: the model learns of it without a turn being started for it (`quiet`).
		expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
		await fire("session_shutdown", {}, ctx);
		await second.done;
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Recorded once, before the stop, so a resumed session knows it did not finish; the exit adds nothing.
		expect(sent).toHaveLength(2);
		expect(sent[1].message).toMatchObject({
			customType: "octocode-bash-job",
			details: { id: "bash-2", log: second.log },
		});
		expect(sent[1].message.content).toMatch(/bash-2 stopped \(session end\)/);
		expect(sent[1].options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
	});

	it("starts a background job and stops it at session end", async () => {
		const { tool, jobs } = setup();
		const result = await tool.execute(
			"t1",
			{ command: "sleep 30", background: true },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }),
		);
		expect(result.content[0].text).toMatch(/background/);
		await jobs.stopAll("session end");
		await Promise.all([...jobs.jobs.values()].map((job) => job.done));
	});

	it("does not claim complete output in the early shutdown report before pipes drain", async () => {
		const { tool, jobs, sent, fire, ctx } = setup();
		await tool.execute(
			"verify-shutdown",
			{ command: "echo before; sleep 30", background: true, verify: true },
			undefined,
			undefined,
			ctx,
		);
		await fire("session_shutdown", {}, ctx);
		expect(sent).toHaveLength(1);
		const receipt = sent[0].message.details.verification;
		expect(receipt).toMatchObject({ state: "running", output: { complete: false } });
		expect(receipt.completedAt).toBeUndefined();
		expect(receipt.revisionAtCompletion).toBeUndefined();
		expect(sent[0].message.content).toContain("no result yet");
		expect(sent[0].message.content).toContain("full output incomplete or unavailable");
		await Promise.all([...jobs.jobs.values()].map((job) => job.done));
		expect(sent).toHaveLength(1);
	});

	it("keeps a job running while children its shell left behind still run, so they stay stoppable", async () => {
		const jobs = new BashJobs(tmp());
		let exited = false;
		const job = await jobs.start("sleep 30 & echo started", tmp(), undefined, () => {
			exited = true;
			return exited;
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		// The shell is gone, its `sleep 30` is not: the job is still listed and stop() reaches it.
		expect(exited).toBe(false);
		expect(jobs.jobs.has(job.id)).toBe(true);
		expect(jobs.stop(job.id, "user")).toBe(true);
		await job.done;
		expect(groupAlive(job.pid)).toBe(false);
	});

	it("escalates to SIGKILL before stopAll resolves, for a job that ignores SIGTERM", async () => {
		const jobs = new BashJobs(tmp());
		const job = await jobs.start(
			"trap '' TERM; echo ready; while :; do sleep 0.05; done",
			tmp(),
			undefined,
			() => undefined,
		);
		await until(() => fs.readFileSync(job.log, "utf8").includes("ready"));
		await jobs.stopAll("session end");
		expect(groupAlive(job.pid)).toBe(false);
	});

	it("settles its jobs for a headless run: waits for timed ones, stops untimed ones, reports both", async () => {
		const { tool, jobs, sent, cwd } = setup();
		const headless = fakeCtx({ cwd, hasUI: false });
		await tool.execute(
			"t1",
			{ command: "sleep 0.3; echo timed-done", background: true, timeout: 20 },
			undefined,
			undefined,
			headless,
		);
		await tool.execute("t2", { command: "sleep 60", background: true }, undefined, undefined, headless);
		// settle() is what index.ts holds a headless run on: it stops the untimed job and waits for the timed one.
		await jobs.settle();
		await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5_000 });
		const reports = sent.map((entry) => String(entry.message.content)).sort();
		expect(
			reports.some((text) => /finished after .*sleep 0\.3; echo timed-done/.test(text) && text.includes("timed-done")),
		).toBe(true);
		expect(reports.some((text) => /stopped \(run end\)/.test(text))).toBe(true);
		expect(jobs.jobs.size).toBe(0);
		// Outside a subagent the timed job's exit still starts the turn that reads it.
		expect(sent.find((entry) => String(entry.message.content).includes("timed-done"))!.options.triggerTurn).toBe(true);
	});

	it("records a subagent's job that ends after its final answer (while settling) without starting a turn", async () => {
		process.env.OCTOCODE_SUBAGENT = "1";
		try {
			const { tool, jobs, sent, cwd } = setup();
			const headless = fakeCtx({ cwd, hasUI: false });
			await tool.execute(
				"t1",
				{ command: "sleep 0.3; echo late", background: true, timeout: 20 },
				undefined,
				undefined,
				headless,
			);
			await jobs.settle();
			await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5_000 });
			expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
			expect(sent[0].message.details).toMatchObject({ id: "bash-1", quiet: true });
		} finally {
			delete process.env.OCTOCODE_SUBAGENT;
		}
	});

	it("records a subagent's job that ends while the child is still working without starting a turn either", async () => {
		process.env.OCTOCODE_SUBAGENT = "1";
		try {
			const { tool, sent, cwd } = setup();
			await tool.execute(
				"t1",
				{ command: "sleep 0.2; echo mid", background: true },
				undefined,
				undefined,
				fakeCtx({ cwd, hasUI: false }),
			);
			// No settle(): the run has not given its final answer, so a woken turn would be a queued follow-up after it.
			await until(() => sent.length === 1);
			expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
			expect(sent[0].message.details).toMatchObject({ id: "bash-1", quiet: true });
		} finally {
			delete process.env.OCTOCODE_SUBAGENT;
		}
	});

	it("starts more than eight jobs at once: there is no running limit", async () => {
		const jobs = new BashJobs(tmp());
		const cwd = tmp();
		for (let index = 0; index < 9; index++) await jobs.start("sleep 30", cwd, undefined, () => undefined);
		expect(jobs.jobs.size).toBe(9);
		await jobs.stopAll("session end");
		await Promise.all([...jobs.jobs.values()].map((job) => job.done));
	});

	it("cuts an orphan job's command without splitting a character in half", () => {
		const notice = orphanNotice([
			{ id: "bash-3", pid: 42, command: `${"a".repeat(79)}\u{1F600}tail`, log: "/tmp/job.log", stopped: true },
		]);
		expect(notice).toContain(`bash-3 · pid 42 · ${"a".repeat(79)}\n`);
		expect(notice.isWellFormed()).toBe(true);
	});

	it("reports a finished job with its last lines and counts the earlier ones the log keeps", () => {
		const dir = tmp();
		const log = path.join(dir, "job.log");
		fs.writeFileSync(log, `${"x".repeat(5000)}\nlast line\n`);
		expect(logTail(log)).toEqual({ text: "last line", earlier: 1 });
		expect(logTail(path.join(dir, "missing.log"))).toEqual({ text: "", earlier: 0 });
		const job = {
			id: "bash-9",
			command: "make",
			cwd: dir,
			pid: 1,
			log,
			startedAt: 0,
			done: Promise.resolve({ code: 0, signal: null, seconds: 75 }),
		};
		expect(jobReport(job, { code: 0, signal: null, seconds: 75 })).toBe(
			`[exit 0 · 75s · 2 lines · 5 KB · log: job.log]\nBackground bash bash-9 finished after 1m15s: make\n[+1 earlier line in the log]\nlast line`,
		);
		// One rotation keeps the earlier output in `.1`; nothing is said to be dropped.
		expect(jobReport(job, { code: 0, signal: null, seconds: 75, logRotations: 1 })).toBe(
			`[exit 0 · 75s · 2 lines · 5 KB · log: job.log]\nBackground bash bash-9 finished after 1m15s: make\nlog rotated at its size cap: job.log.1 is unavailable; earlier output cannot be recovered\n[+1 earlier line in the log]\nlast line`,
		);
		// The tail is the end of the log (not the start of its last few KB), and nothing before it goes uncounted.
		fs.writeFileSync(log, Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"));
		const report = jobReport(job, { code: 0, signal: null, seconds: 1 }).split("\n");
		expect(report[0]).toMatch(/^\[exit 0 · 1s · 100 lines · \d+ B · log: job\.log\]$/);
		expect(report.slice(2, 4)).toEqual(["[+60 earlier lines in the log]", "line 61"]);
		expect(report.at(-1)).toBe("line 100");
	});

	it("starts a job report with a status header: exit or signal, seconds, size and the log", () => {
		const dir = tmp();
		const log = path.join(dir, "job.log");
		fs.writeFileSync(log, Array.from({ length: 48_213 }, (_, i) => `row ${i}`).join("\n"));
		const job = {
			id: "bash-3",
			command: "make",
			cwd: dir,
			pid: 1,
			log,
			startedAt: 0,
			done: Promise.resolve(),
		} as never;
		const header = (exit: Parameters<typeof jobReport>[1], stopped?: string) =>
			jobReport({ ...(job as object), ...(stopped ? { stopped } : {}), timeout: 60 } as never, exit).split("\n")[0];
		expect(header({ code: 1, signal: null, seconds: 61 })).toMatch(
			/^\[exit 1 · 61s · 48,213 lines · \d+ KB · log: job\.log\]$/,
		);
		expect(header({ code: null, signal: "SIGTERM", seconds: 2 })).toContain("[signal SIGTERM · 2s · ");
		expect(header({ code: null, signal: "SIGTERM", seconds: 60 }, "timeout")).toContain(
			"[timed out after 60s · 60s · ",
		);
		expect(header({ code: null, signal: null, seconds: 3 }, "user")).toContain("[stopped (user) · 3s · ");
		fs.writeFileSync(log, "");
		expect(header({ code: 0, signal: null, seconds: 1 })).toBe("[exit 0 · 1s · no output · log: job.log]");
	});

	it("drops colors from the reported log tail and shows other terminal escapes as visible escapes", () => {
		const dir = tmp();
		const log = path.join(dir, "job.log");
		fs.writeFileSync(log, "\u001b[32mPASS\u001b[0m tests\r\n\u001b]0;title\u0007done\n");
		const job = {
			id: "bash-8",
			command: "yarn test",
			cwd: dir,
			pid: 1,
			log,
			startedAt: 0,
			done: Promise.resolve({ code: 0, signal: null, seconds: 1 }),
		};
		expect(jobReport(job, { code: 0, signal: null, seconds: 1 }).split("\n").slice(2)).toEqual([
			"PASS tests\r",
			"\\u{1b}]0;title\\u{7}done",
		]);
	});
});

describe("bash rendering", () => {
	const setup = () => {
		const { api, tools, renderers } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()));
		return { tool: tools.get("bash"), renderers };
	};
	const done = (extra: Record<string, unknown> = {}) => ({
		lastComponent: undefined,
		isPartial: false,
		isError: false,
		state: {},
		...extra,
	});

	it("heads the call with the command and shows a timeout only when the model set one", () => {
		const { tool } = setup();
		expect(
			rendered(
				tool.renderCall({ command: "yarn test" }, theme, {
					lastComponent: undefined,
					isPartial: true,
					executionStarted: false,
				}),
			),
		).toBe("○ Bash(yarn test)");
		expect(
			rendered(
				tool.renderCall({ command: "sleep 1", timeout: 30 }, theme, { lastComponent: undefined, isPartial: true }),
			),
		).toBe("○ Bash(sleep 1) · timeout 30s");
		expect(rendered(tool.renderCall({ command: "serve", background: true }, theme, done({ durationMs: 4_000 })))).toBe(
			"✓ Bash(serve) · background · 4s",
		);
	});

	it("summarizes exit, line count and the last lines of output", () => {
		const { tool } = setup();
		const short = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
		const whole = rendered(
			tool.renderResult(
				{ content: [{ type: "text", text: short }] },
				{ expanded: false, isPartial: false },
				theme,
				done(),
			),
		).split("\n");
		// A short output shows whole: folding it would hide a few lines behind a one-line hint.
		expect(whole).toHaveLength(13);
		expect(whole.join("\n")).not.toContain("to expand");
		const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const lines = rendered(
			tool.renderResult(
				{ content: [{ type: "text", text }] },
				{ expanded: false, isPartial: false },
				theme,
				done({ durationMs: 1_500 }),
			),
		).split("\n");
		expect(lines).toEqual([
			"  ⎿  exit 0 · 20 lines",
			"     … +15 earlier lines (ctrl+o to expand)",
			"     line 16",
			"     line 17",
			"     line 18",
			"     line 19",
			"     line 20",
		]);
		const expanded = rendered(
			tool.renderResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false }, theme, done()),
		);
		expect(expanded.split("\n")).toHaveLength(21);
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text: "(no output)" }] },
					{ expanded: false, isPartial: false },
					theme,
					done(),
				),
			),
		).toBe("  ⎿  exit 0 · no output");
	});

	it("reads only the tail of a collapsed output, with the same counts as the whole", () => {
		const { tool } = setup();
		const many = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
		const texts = [
			`\n\n${many}\n\nCommand exited with code 0`,
			`head\n\n\n${many}\n\n\n`,
			`a\rprogress 50%\rprogress 100%\n\u2028${many}\n\u001b[31mred\u001b[0m\n   \n`,
			`${many}\n\n[Showing lines 1-500 of 9000. Full output: /tmp/out.log]\n\nCommand exited with code 0`,
			"x\n\n\n\ny\n\n\nz",
		];
		for (const text of texts) {
			for (const isPartial of [true, false]) {
				const view = (expanded: boolean) =>
					rendered(
						tool.renderResult({ content: [{ type: "text", text }] }, { expanded, isPartial }, theme, done()),
					).split("\n");
				const collapsed = view(false);
				const expanded = view(true);
				expect(collapsed[0].replace(" (ctrl+o to expand)", "")).toBe(expanded[0]);
				const body = expanded.slice(1).filter((line) => !line.trimStart().startsWith("saved:"));
				if (!/to expand/.test(collapsed[1] ?? "")) {
					// A short output is shown whole, without its blank lines.
					expect(collapsed.slice(1)).toEqual(body.filter((line) => line.trim() !== ""));
					continue;
				}
				const hidden = Number(/\+(\d+) earlier lines?/.exec(collapsed[1])?.[1] ?? 0);
				expect(hidden + collapsed.slice(2).length).toBe(body.length);
				expect(collapsed.slice(-3)).toEqual(body.filter((line) => line.trim() !== "").slice(-3));
			}
		}
	});

	it("draws failures as errors and keeps the spill path", () => {
		const { tool } = setup();
		const text = "a\nb\n\n[Showing lines 1-2 of 900. Full output: /tmp/out.log]\n\nCommand exited with code 2";
		const lines = rendered(
			tool.renderResult(
				{ content: [{ type: "text", text }] },
				{ expanded: false, isPartial: false },
				theme,
				done({ isError: true }),
			),
		).split("\n");
		expect(lines).toEqual(["  ⎿  Error: exit 2 · 900 lines (ctrl+o to expand)", "     a", "     b"]);
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text }] },
					{ expanded: true, isPartial: false },
					theme,
					done({ isError: true }),
				),
			),
		).toMatch(/\n {5}saved: \/tmp\/out\.log$/);
		const timeout = rendered(
			tool.renderResult(
				{
					content: [
						{
							type: "text",
							text: `Command timed out after 120 seconds.\n${RERUN_HINT} with a longer timeout, or with background: true and check its log.`,
						},
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				done({ isError: true }),
			),
		);
		expect(timeout).toBe("  ⎿  Error: timed out after 2m · no output");
		const killed = rendered(
			tool.renderResult(
				{ content: [{ type: "text", text: "build line\n\nCommand terminated without an exit code" }] },
				{ expanded: false, isPartial: false },
				theme,
				done({ isError: true }),
			),
		);
		expect(killed.split("\n")[0]).toBe("  ⎿  Error: terminated (no exit code) · 1 line");
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text: "Working directory does not exist" }] },
					{ expanded: false, isPartial: false },
					theme,
					done({ isError: true }),
				),
			),
		).toBe("  ⎿  Error: Working directory does not exist");
	});

	it("shows a started job and a running tail", () => {
		const { tool, renderers } = setup();
		expect(
			rendered(
				tool.renderResult(
					{
						content: [{ type: "text", text: "Moved" }],
						details: { job: "bash-1", pid: 42, log: "/tmp/j.log", moved: true },
					},
					{ expanded: false, isPartial: false },
					theme,
					done(),
				),
			),
		).toBe("  ⎿  job bash-1 moved to the background (pid 42) (ctrl+o to expand)");
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text: "Started" }], details: { job: "bash-1", pid: 42, log: "/tmp/j.log" } },
					{ expanded: false, isPartial: false },
					theme,
					done(),
				),
			),
		).toBe("  ⎿  job bash-1 started (pid 42) (ctrl+o to expand)");
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text: "Started" }], details: { job: "bash-1", pid: 42, log: "/tmp/j.log" } },
					{ expanded: true, isPartial: false },
					theme,
					done(),
				),
			),
		).toBe("  ⎿  job bash-1 started (pid 42)\n     log: /tmp/j.log");
		expect(
			rendered(
				tool.renderResult(
					{ content: [{ type: "text", text: "one\ntwo" }] },
					{ expanded: false, isPartial: true },
					theme,
					{ lastComponent: undefined, isPartial: true, executionStarted: true, state: {} },
				),
			),
		).toBe("  ⎿  running · 2 lines\n     one\n     two");
		const job = [...renderers.values()][0];
		const message = { content: "Background bash bash-1 finished after 3s: yarn build\nLog: /tmp/j.log\nok" };
		expect(rendered(job(message, { expanded: false }, theme))).toBe(
			" ✓ Bash(bash-1: yarn build) · background\n   ⎿  finished after 3s (ctrl+o to expand)\n      ok",
		);
		expect(rendered(job(message, { expanded: true }, theme))).toBe(
			" ✓ Bash(bash-1: yarn build) · background\n   ⎿  finished after 3s\n      ok\n      log: /tmp/j.log",
		);
		// A report that opens with the status header names its log there instead of on a `Log:` line.
		const headed = {
			content:
				"[exit 0 · 3s · 1 line · 3 B · log: /tmp/j.log]\nBackground bash bash-1 finished after 3s: yarn build\nok",
		};
		expect(rendered(job(headed, { expanded: true }, theme))).toBe(
			" ✓ Bash(bash-1: yarn build) · background\n   ⎿  finished after 3s\n      ok\n      log: /tmp/j.log",
		);
		// A job the user killed is interrupted, not failed.
		const colored = { ...(theme as object), fg: (color: string, text: string) => `<${color}>${text}` };
		const killed = rendered(
			job(
				{ content: "Background bash bash-1 stopped (user) after 3s: yarn build\nLog: /tmp/j.log\n(no output)" },
				{ expanded: false },
				colored,
			),
		);
		expect(killed).toContain("<warning>◼");
		expect(killed).not.toContain("<error>");
	});
});
