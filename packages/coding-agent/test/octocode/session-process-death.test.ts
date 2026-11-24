import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { runCommandHook } from "../../src/octocode/hooks/command.ts";
import { tmp } from "./helpers.ts";

/**
 * Hook shells and background bash jobs end with the session that started them: when it ends normally, when the call is
 * stopped, and when the owner process dies without any cleanup (SIGTERM with no handler, SIGKILL).
 */

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const HOOKS = pathToFileURL(path.join(SRC, "octocode", "hooks", "command.ts")).href;
const JOBS = pathToFileURL(path.join(SRC, "octocode", "files", "bash-jobs.ts")).href;
vi.setConfig({ testTimeout: 90_000 });

const alive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Whether the group's root process itself still exists (reaped once it exits), apart from the rest of its group. */
const rootAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const groups: number[] = [];
const owners: ChildProcess[] = [];
afterEach(() => {
	for (const pid of groups.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const owner of owners.splice(0)) owner.kill("SIGKILL");
});

/** A session process that starts one long-lived hook or job, publishes its group pid, then idles. */
const OWNER = `
import fs from "node:fs";
import { runCommandHook } from ${JSON.stringify(HOOKS)};
import { BashJobs } from ${JSON.stringify(JOBS)};
const [kind, dir, out, bg] = process.argv.slice(2);
const body = bg === "bg" ? "sleep 300 >/dev/null 2>&1 &" : "sleep 300";
if (kind === "hook") {
	void runCommandHook({ command: "echo $$ > " + out + ".tmp; mv " + out + ".tmp " + out + "; " + body, timeoutMs: 600000, source: "t" }, {}, dir, process.env);
} else {
	const job = await new BashJobs(dir).start(bg === "bg" ? "sleep 300 >/dev/null 2>&1 &" : "sleep 300", dir, undefined, () => {});
	fs.writeFileSync(out, String(job.pid));
}
setInterval(() => {}, 1000);
`;

async function startOwner(kind: "hook" | "job", bg = false): Promise<{ owner: ChildProcess; pid: number }> {
	const dir = tmp("octocode-death-");
	const script = path.join(dir, "owner.mjs");
	const out = path.join(dir, "pid");
	fs.writeFileSync(script, OWNER);
	const owner = spawn(process.execPath, ["--import", SOURCE_RESOLVER, script, kind, dir, out, bg ? "bg" : "fg"], {
		stdio: "ignore",
	});
	owners.push(owner);
	await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true), { timeout: 60_000, interval: 100 });
	const pid = Number(fs.readFileSync(out, "utf8"));
	groups.push(pid);
	// A backgrounded child outlives its root: wait until the root is gone, the group still lives.
	if (bg) await vi.waitFor(() => expect(rootAlive(pid)).toBe(false), { timeout: 30_000, interval: 100 });
	expect(alive(pid)).toBe(true);
	return { owner, pid };
}

describe.runIf(process.platform !== "win32")("processes of a session that ends", () => {
	for (const kind of ["hook", "job"] as const) {
		for (const signal of ["SIGKILL", "SIGTERM"] as const) {
			it(`a ${kind} group is gone after its owner's ${signal}`, async () => {
				const { owner, pid } = await startOwner(kind);
				owner.kill(signal);
				await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 100 });
			});
		}
	}

	for (const kind of ["hook", "job"] as const) {
		it(`a ${kind} whose root exited with a background child is gone after its owner's SIGKILL`, async () => {
			const { owner, pid } = await startOwner(kind, true);
			owner.kill("SIGKILL");
			await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 100 });
		});
	}

	it("a hook's background child outlives the hook while its owner lives", async () => {
		const { pid } = await startOwner("hook", true);
		// The hook's own shell has exited and been reaped; its group lives on in the background child.
		await vi.waitFor(() => expect(rootAlive(pid)).toBe(false), { timeout: 30_000, interval: 100 });
		expect(alive(pid)).toBe(true);
	});

	it("a job whose root exited with a live child is stopped by the session's end", async () => {
		const dir = tmp("octocode-job-stray-");
		const jobs = new BashJobs(dir);
		const job = await jobs.start("sleep 300 >/dev/null 2>&1 &", dir, undefined, () => {});
		groups.push(job.pid);
		await vi.waitFor(() => expect(rootAlive(job.pid)).toBe(false), { timeout: 30_000, interval: 100 });
		expect(alive(job.pid)).toBe(true);
		await jobs.stopAll("session end");
		expect(alive(job.pid)).toBe(false);
	});

	it("a hook that ends normally leaves no group behind", async () => {
		const dir = tmp("octocode-hook-end-");
		const pidFile = path.join(dir, "pid");
		const run = await runCommandHook(
			{ command: `echo $$ > ${pidFile}; sleep 0.2; echo done`, timeoutMs: 10_000, source: "t" },
			{},
			dir,
			process.env,
		);
		expect(run.code).toBe(0);
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		groups.push(pid);
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000 });
	});

	it("a stopped hook leaves no group behind", async () => {
		const dir = tmp("octocode-hook-stop-");
		const pidFile = path.join(dir, "pid");
		const stop = new AbortController();
		const running = runCommandHook(
			{ command: `echo $$ > ${pidFile}; sleep 300`, timeoutMs: 600_000, source: "t" },
			{},
			dir,
			process.env,
			stop.signal,
		);
		await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8").trim()).not.toBe(""), { timeout: 30_000 });
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		groups.push(pid);
		stop.abort();
		await running;
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000 });
	});

	it("a job the user stops leaves no group behind", async () => {
		const dir = tmp("octocode-job-stop-");
		const jobs = new BashJobs(dir);
		const job = await jobs.start("sleep 300", dir, undefined, () => {});
		groups.push(job.pid);
		expect(jobs.stop(job.id, "user")).toBe(true);
		await vi.waitFor(() => expect(alive(job.pid)).toBe(false), { timeout: 30_000 });
	});

	it("every running job's group is gone once the session's end stops them", async () => {
		const dir = tmp("octocode-job-end-");
		const jobs = new BashJobs(dir);
		const started = await Promise.all([1, 2].map(() => jobs.start("sleep 300", dir, undefined, () => {})));
		groups.push(...started.map((job) => job.pid));
		await jobs.stopAll("session end");
		for (const job of started) expect(alive(job.pid)).toBe(false);
	});
});
