import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setCurrentSession } from "../../src/config/runtime-paths.ts";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import {
	groupAlive,
	groupStartTimes,
	killTree,
	processAlive,
	processStartTime,
	stopTree,
} from "../../src/octocode/shared/process.ts";
import { signalTree } from "../../src/utils/process-tree.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { jobReport } from "../../src/octocode/files/bash-jobs/report.ts";
import { reapOrphanJobs, recordFile } from "../../src/octocode/files/bash-jobs/records.ts";

const until = async (check: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const posix = process.platform !== "win32";
const hasPerl = posix && spawnSync("perl", ["-e", "1"]).status === 0;

const setup = () => {
	const { api, tools, sent, fire } = fakeHost();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), jobs, () => ({}));
	const cwd = tmp();
	return { tool: tools.get("bash"), jobs, sent, fire, cwd, ctx: fakeCtx({ cwd }) };
};

/** A pid that belonged to a process that has exited. */
const deadPid = (): number => {
	const child = spawnSync("sh", ["-c", "echo $$"]);
	return Number(String(child.stdout).trim());
};

describe.runIf(posix)("foreground bash process handling", () => {
	it("sends SIGTERM first at the deadline, so the command can clean up before SIGKILL", async () => {
		const { tool, ctx } = setup();
		const message = await tool
			.execute(
				"t1",
				{ command: "sleep 0; trap 'echo cleaned-up; exit 1' TERM; echo ready; sleep 30 & wait", timeout: 1 },
				undefined,
				undefined,
				ctx,
			)
			.catch((error: Error) => error.message);
		expect(message).toMatch(/^\[timed out after 1s · 2 lines[\s\S]*ready[\s\S]*cleaned-up/);
		expect(message).toMatch(/a longer timeout, or with background: true/);
	});

	it("names processes a command left running in its group, with how to stop them, and leaves them running", async () => {
		const { tool, ctx } = setup();
		const result = await tool.execute(
			"t1",
			{ command: "sleep 30 >/dev/null 2>&1 & echo started" },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content[0].text as string;
		const match =
			/Still running after the command returned \(not stopped\): (\d+) sleep 30\. Stop: kill -- -(\d+)\./.exec(text);
		expect(match).not.toBeNull();
		const [, stray, group] = match!.map(Number) as [number, number, number];
		expect(processAlive(stray)).toBe(true);
		process.kill(-group, "SIGKILL");
		await until(() => !groupAlive(group));
		// A command that leaves nothing behind gets no note.
		const clean = await tool.execute("t2", { command: "echo only" }, undefined, undefined, ctx);
		expect(clean.content[0].text).toMatch(/^\[exit 0 · [\d.]+s · 1 line · 5 B\]\nonly\n$/);
	});
});

describe.runIf(posix)("foreground command that reaches its deadline", () => {
	it("keeps running as a background job and later reports its exit with the output from before and after the move", async () => {
		const { tool, jobs, sent, ctx } = setup();
		const result = await tool.execute(
			"t1",
			{ command: "echo before; sleep 2; echo after; exit 3", timeout: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toMatch(/moved to the background as bash-1/);
		expect(sent).toHaveLength(0);
		await until(() => sent.length === 1, 8_000);
		const report = sent[0].message.content as string;
		expect(report).toMatch(
			/^\[exit 3 · [23]s · [^\n]*\]\nBackground bash bash-1 failed with exit code 3 after [23]s: echo before; sleep 2/,
		);
		expect(report).toMatch(/before\nafter$/);
		// Like any background job: reported as a follow-up that wakes an idle session, and gone from the job list.
		expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(sent[0].message.details.id).toBe("bash-1");
		expect(fs.readFileSync(sent[0].message.details.log, "utf8")).toBe("before\nafter\n");
		expect(jobs.jobs.size).toBe(0);
	});

	it("moves a command with a stderr stream and a later exit 0 as finished", async () => {
		const { tool, sent, ctx } = setup();
		await tool.execute("t1", { command: "echo out; sleep 1.5; echo err >&2", timeout: 1 }, undefined, undefined, ctx);
		await until(() => sent.length === 1, 8_000);
		expect(sent[0].message.content).toMatch(/bash-1 finished after [12]s[\s\S]*out\nerr$/);
	});

	it("stops a moved command at session end, with its whole process group", async () => {
		const { tool, jobs, sent, fire, ctx } = setup();
		await tool.execute("t1", { command: "{ sleep 30 & }; echo started; wait", timeout: 1 }, undefined, undefined, ctx);
		const job = jobs.jobs.get("bash-1")!;
		expect(groupAlive(job.pid)).toBe(true);
		await fire("session_shutdown", {}, ctx);
		expect(groupAlive(job.pid)).toBe(false);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toMatch(/bash-1 stopped \(session end\)[\s\S]*started/);
		expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("is stopped by /jobs kill, with SIGTERM first so it can clean up", async () => {
		const { api, tools, sent } = fakeHost();
		const commands = new Subcommands();
		const jobs = new BashJobs(tmp());
		registerBashTool(api, commands, jobs, () => ({}));
		const ctx = fakeCtx({ cwd: tmp() });
		await tools
			.get("bash")
			.execute(
				"t1",
				{ command: "trap 'echo cleaned-up; exit 1' TERM; echo ready; sleep 30 & wait", timeout: 1 },
				undefined,
				undefined,
				ctx,
			);
		const job = jobs.jobs.get("bash-1")!;
		await commands.get("jobs")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/^bash-1 · \d+s · pid \d+ · trap /);
		await commands.get("jobs")!.handler("kill bash-1", ctx);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toMatch(/bash-1 stopped \(user\)[\s\S]*ready\ncleaned-up/);
		expect(groupAlive(job.pid)).toBe(false);
		expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("is stopped at the end of a headless run, since it has no timeout of its own", async () => {
		const { tool, jobs, sent, ctx } = setup();
		await tool.execute("t1", { command: "echo up; sleep 30", timeout: 1 }, undefined, undefined, ctx);
		const job = jobs.jobs.get("bash-1")!;
		expect(job.timeout).toBeUndefined();
		const started = Date.now();
		await jobs.settle();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(job.stopped).toBe("run end");
		expect(groupAlive(job.pid)).toBe(false);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toMatch(/bash-1 stopped \(run end\)[\s\S]*up/);
	});

	it("does not move a command that starts with sleep: it is stopped at the deadline", async () => {
		const { tool, jobs, ctx } = setup();
		for (const command of ["sleep 30", "  sleep 30 && echo done"]) {
			await expect(tool.execute("t1", { command, timeout: 1 }, undefined, undefined, ctx)).rejects.toThrow(
				/\[timed out after 1s · /,
			);
		}
		// `sleep` only as a first word: a command that merely mentions it moves.
		await tool.execute("t2", { command: "echo sleep; sleep 30", timeout: 1 }, undefined, undefined, ctx);
		expect(jobs.jobs.size).toBe(1);
		await jobs.stopAll("session end");
	});

	it("keeps killing a command the user aborts, before or after the deadline would have come", async () => {
		const { tool, jobs, ctx } = setup();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		await expect(
			tool.execute("t1", { command: "echo started; sleep 30", timeout: 30 }, controller.signal, undefined, ctx),
		).rejects.toThrow(/^\[aborted · /);
		expect(jobs.jobs.size).toBe(0);
	});

	it("falls back to stopping the command when it cannot become a job", async () => {
		const dir = path.join(tmp(), "gone");
		fs.writeFileSync(dir, "a file where the log folder should be");
		const { api, tools } = fakeHost();
		const jobs = new BashJobs(dir);
		registerBashTool(api, new Subcommands(), jobs, () => ({}));
		const message = await tools
			.get("bash")
			.execute("t1", { command: "echo x; sleep 30", timeout: 1 }, undefined, undefined, fakeCtx({ cwd: tmp() }))
			.catch((error: Error) => error.message);
		expect(message).toMatch(/^\[timed out after 1s · /);
		expect(jobs.jobs.size).toBe(0);
	});
});

describe.runIf(posix)("background job lifecycle", () => {
	it.runIf(hasPerl)("reports a job that exited just before shutdown with its own status, not as stopped", async () => {
		const { tool, jobs, sent, fire, ctx } = setup();
		// The shell exits with 3 while a process outside its group keeps the output pipe open, so the job sits in its drain time.
		await tool.execute(
			"t1",
			{ command: "perl -e 'setpgrp(0,0); sleep 3' & echo out; exit 3", background: true },
			undefined,
			undefined,
			ctx,
		);
		const job = jobs.jobs.get("bash-1")!;
		await until(() => job.exited === true);
		expect(jobs.jobs.has("bash-1")).toBe(true);
		await fire("session_shutdown", {}, ctx);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toMatch(/^\[exit 3 · [^\n]*\]\nBackground bash bash-1 failed with exit code 3/);
		expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("labels jobs a /reload stops and names them in the next session", async () => {
		const { tool, sent, fire, ctx, jobs } = setup();
		await tool.execute("t1", { command: "sleep 30", background: true }, undefined, undefined, ctx);
		await fire("session_shutdown", { reason: "reload" }, ctx);
		expect(sent[0].message.content).toMatch(/bash-1 stopped \(reload\)/);
		expect(jobs.jobs.size).toBe(0);
		// The next extension instance (same process, same session folder) reads the note once.
		const next = fakeHost();
		registerBashTool(next.api, new Subcommands(), new BashJobs(jobs.logDir()), () => ({}));
		const fresh = fakeCtx({ cwd: ctx.cwd });
		await next.fire("session_start", { reason: "reload" }, fresh);
		expect(fresh.ui.notes.map((note) => note.message).join("\n")).toMatch(
			/\/reload stopped 1 background bash job:\n {2}bash-1 · sleep 30\n {4}log: .*bash-1-\d+\.log/,
		);
		await next.fire("session_start", { reason: "reload" }, fresh);
		expect(fresh.ui.notes.filter((note) => /\/reload stopped/.test(note.message))).toHaveLength(1);
	});

	it("keeps the owner record in private state while the workspace holds the log, and removes the record at exit", async () => {
		const home = tmp();
		const cwd = tmp();
		vi.stubEnv("OCTOCODE_HOME", home);
		setCurrentSession("job-owner", cwd);
		const jobs = new BashJobs();
		try {
			let exited = false;
			const job = await jobs.start("sleep 0.3", cwd, undefined, () => {
				exited = true;
			});
			const record = recordFile(job.log);
			expect(job.log).toContain(path.join(".octa", "code", "temp", "sessions", "job-owner", "bash"));
			expect(path.dirname(path.dirname(record))).toBe(path.join(home, "agent", "job-owners"));
			expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({
				id: job.id,
				pid: job.pid,
				command: "sleep 0.3",
				log: job.log,
				owner: { pid: process.pid },
			});
			expect(fs.statSync(record).mode & 0o777).toBe(0o600);
			expect(await reapOrphanJobs(jobs.recordDirs())).toEqual([]);
			await until(() => exited);
			expect(fs.existsSync(record)).toBe(false);
		} finally {
			await jobs.stopAll("session end");
			setCurrentSession(undefined);
			vi.unstubAllEnvs();
		}
	});

	it("stops a job whose Octocode died and tells the user which, with its log", async () => {
		const dir = tmp();
		const jobs = new BashJobs(dir);
		const job = await jobs.start("sleep 30", tmp(), undefined, () => undefined);
		const record = recordFile(job.log);
		// Its Octocode crashed: the owner in the record is a process that is gone.
		const owned = JSON.parse(fs.readFileSync(record, "utf8"));
		fs.writeFileSync(
			record,
			JSON.stringify({ ...owned, owner: { pid: deadPid(), started: "Mon Jan  1 00:00:00 2001" } }),
		);
		const { api, fire } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(dir), () => ({}));
		const ctx = fakeCtx({ cwd: tmp() });
		await fire("session_start", { reason: "startup" }, ctx);
		expect(groupAlive(job.pid)).toBe(false);
		expect(fs.existsSync(record)).toBe(false);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(
			new RegExp(
				`^Stopped 1 background bash job left running by a Octocode that exited without ending it:\\n {2}${job.id} · pid ${job.pid} · sleep 30\\n {4}log: .*${path.basename(job.log)}$`,
			),
		);
		expect(ctx.ui.notes.at(-1)!.type).toBe("warning");
	});

	it("leaves a recorded pid alone once it names another process, and drops the record", async () => {
		const dir = tmp();
		const record = path.join(dir, "bash-1-1.job.json");
		// The job's pid is alive (this test runner) but started at another time: the pid was reused.
		fs.writeFileSync(
			record,
			JSON.stringify({
				id: "bash-1",
				pid: process.pid,
				started: "Mon Jan  1 00:00:00 2001",
				command: "x",
				log: path.join(dir, "bash-1-1.log"),
				owner: { pid: deadPid() },
			}),
		);
		expect(await reapOrphanJobs([dir])).toEqual([]);
		expect(processAlive(process.pid)).toBe(true);
		expect(fs.existsSync(record)).toBe(false);
		expect(execFileSync("ls", [dir], { encoding: "utf8" })).toBe("");
	});
});

describe.runIf(posix)("orphan reaper: only proven jobs are stopped", () => {
	/** A Octocode that died: its job's record names an owner that is gone. */
	const orphan = (record: string, extra: Record<string, unknown> = {}) =>
		fs.writeFileSync(
			record,
			JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), owner: { pid: deadPid() }, ...extra }),
		);
	/** A detached group whose leader exited and left `sleep` running in it, as another Octocode's `server &` would. */
	const leaderlessGroup = async (): Promise<number> => {
		const child = spawn("sh", ["-c", "sleep 30 >/dev/null 2>&1 & exit 0"], { detached: true, stdio: "ignore" });
		await new Promise((resolve) => child.once("exit", resolve));
		await until(() => !processAlive(child.pid) && groupAlive(child.pid));
		return child.pid!;
	};
	const write = (dir: string, name: string, record: Record<string, unknown>) => {
		const file = path.join(dir, name);
		fs.writeFileSync(
			file,
			JSON.stringify({
				id: "bash-1",
				command: "server",
				log: path.join(dir, "bash-1-1.log"),
				owner: { pid: deadPid() },
				...record,
			}),
		);
		return file;
	};

	it("stops a job whose shell exited but left its group running", async () => {
		const dir = tmp();
		const job = await new BashJobs(dir).start("sleep 30 >/dev/null 2>&1 & exit 0", tmp(), undefined, () => undefined);
		await until(() => !processAlive(job.pid) && groupAlive(job.pid));
		orphan(recordFile(job.log));
		expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ id: job.id, stopped: true })]);
		expect(groupAlive(job.pid)).toBe(false);
	});

	it("leaves alone a group whose leader is gone when it is not provably the job's: an older member, or a later job under the pid", async () => {
		const dir = tmp();
		const group = await leaderlessGroup();
		try {
			const started = Number(groupStartTimes(group)![0].started);
			// The pid was reused as this group's leader after the job started: its member is older than the recorded job.
			const reused = write(dir, "bash-1-1.job.json", { pid: group, started: String(started + 3600) });
			expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ pid: group, stopped: false })]);
			expect(groupAlive(group)).toBe(true);
			expect(fs.existsSync(reused)).toBe(false);
			// Members are newer than the job, but a later job (another live Octocode's) was recorded under the same pid.
			write(dir, "bash-1-1.job.json", { pid: group, started: String(started - 3600) });
			const other = write(dir, "bash-9-9.job.json", {
				pid: group,
				started: String(started),
				owner: { pid: process.pid },
			});
			expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ pid: group, stopped: false })]);
			expect(groupAlive(group)).toBe(true);
			expect(fs.existsSync(other)).toBe(true);
		} finally {
			process.kill(-group, "SIGKILL");
		}
	});

	it("leaves a job alone and keeps its record when ps cannot tell which process the pid is", async () => {
		const dir = tmp();
		const job = await new BashJobs(dir).start("sleep 30", tmp(), undefined, () => undefined);
		const record = recordFile(job.log);
		orphan(record);
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ id: job.id, stopped: false })]);
		} finally {
			process.env.PATH = savedPath;
		}
		expect(processAlive(job.pid)).toBe(true);
		expect(fs.existsSync(record)).toBe(true);
		// The next start, with a working ps, stops it.
		expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ id: job.id, stopped: true })]);
		expect(groupAlive(job.pid)).toBe(false);
	});

	it("drops records naming pid 1 or less without signalling anything, and never signals such a pid", async () => {
		const dir = tmp();
		const owner = deadPid();
		for (const [index, pid] of [-1, 0, 1].entries())
			write(dir, `bash-${index}-1.job.json`, { pid, started: "1", owner: { pid: owner } });
		write(dir, "bash-3-1.job.json", { pid: owner, started: "1", owner: { pid: -1 } });
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			expect(await reapOrphanJobs([dir])).toEqual([]);
			for (const pid of [-1, 0, 1]) {
				signalTree(pid, "SIGTERM");
				killTree(pid);
				await stopTree(pid);
			}
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("leaves records from another host untouched", async () => {
		const dir = tmp();
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		try {
			const record = write(dir, "bash-1-1.job.json", {
				pid: child.pid,
				// The foreign host supplied this time. Its clock and local process table do not identify our child.
				started: "1",
				host: `not-${os.hostname()}`,
			});
			expect(await reapOrphanJobs([dir])).toEqual([]);
			expect(processAlive(child.pid)).toBe(true);
			expect(fs.existsSync(record)).toBe(true);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("judges start times the same in any time zone", async () => {
		const savedTz = process.env.TZ;
		try {
			process.env.TZ = "America/Los_Angeles";
			const dir = tmp();
			const job = await new BashJobs(dir).start("sleep 30", tmp(), undefined, () => undefined);
			const record = recordFile(job.log);
			expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({
				started: expect.stringMatching(/^\d+$/),
				host: os.hostname(),
			});
			const started = processStartTime(job.pid);
			orphan(record);
			// Another Octocode, in another zone, reads the record.
			process.env.TZ = "Pacific/Kiritimati";
			expect(processStartTime(job.pid)).toBe(started);
			expect(await reapOrphanJobs([dir])).toEqual([expect.objectContaining({ id: job.id, stopped: true })]);
		} finally {
			if (savedTz === undefined) delete process.env.TZ;
			else process.env.TZ = savedTz;
		}
	});

	it("retries a record whose reaper died mid-way, never one a live reaper holds", async () => {
		const dir = tmp();
		const stale = write(dir, `bash-1-1.job.json.reaping-${deadPid()}`, { pid: deadPid(), started: "1" });
		const held = write(dir, `bash-2-1.job.json.reaping-${process.ppid}`, { pid: deadPid(), started: "1" });
		expect(await reapOrphanJobs([dir])).toEqual([]);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual([path.basename(held)]);
	});

	it.runIf(posix)(
		"releases a claim whose pid now names another process, and keeps one its own process holds",
		async () => {
			const dir = tmp();
			const ownerStart = processStartTime(process.ppid)!;
			// The reaper died and its pid went to the process that is this one's parent: the start time tells them apart.
			const reused = write(dir, `bash-1-1.job.json.reaping-${process.ppid}-1`, { pid: deadPid(), started: "1" });
			const held = write(dir, `bash-2-1.job.json.reaping-${process.ppid}-${ownerStart}`, {
				pid: deadPid(),
				started: "1",
			});
			expect(await reapOrphanJobs([dir])).toEqual([]);
			expect(fs.existsSync(reused)).toBe(false);
			expect(fs.readdirSync(dir)).toEqual([path.basename(held)]);
		},
	);
});

describe.runIf(posix)("job log failures", () => {
	it("records the first write error, stops writing and says so in the job report", async () => {
		const write = fs.writeSync;
		const spy = vi.spyOn(fs, "writeSync").mockImplementation((fd: number, data: unknown, ...rest: unknown[]) => {
			if (Buffer.isBuffer(data) && data.toString().includes("doomed"))
				throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			return (write as (...args: unknown[]) => number)(fd, data, ...rest);
		});
		try {
			const jobs = new BashJobs(tmp());
			let exit: Parameters<typeof jobReport>[1] | undefined;
			const job = await jobs.start(
				"echo ok1; sleep 0.3; echo doomed; sleep 0.3; echo after",
				tmp(),
				undefined,
				(_job, done) => {
					exit = done;
					return exit;
				},
			);
			await until(() => exit !== undefined);
			expect(exit!.logStopped).toEqual({ bytes: 4, error: "ENOSPC: no space left on device, write" });
			const report = jobReport(job, exit!);
			expect(report).toContain("log stopped at 4 bytes: ENOSPC: no space left on device, write");
			expect(fs.readFileSync(job.log, "utf8")).toBe("ok1\n");
		} finally {
			spy.mockRestore();
		}
	});

	it("reports nothing extra when the log kept recording", async () => {
		const jobs = new BashJobs(tmp());
		let exit: Parameters<typeof jobReport>[1] | undefined;
		const job = await jobs.start("echo fine", tmp(), undefined, (_job, done) => {
			exit = done;
			return exit;
		});
		await until(() => exit !== undefined);
		expect(exit!.logStopped).toBeUndefined();
		expect(jobReport(job, exit!)).not.toContain("log stopped");
	});
});
