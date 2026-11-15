import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "./helpers.ts";

/** A background job dies with Octocode even when the session's shutdown never runs: a crash or a plain `process.exit`. */

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const JOBS = pathToFileURL(path.join(SRC, "octocode", "files", "bash-jobs.ts")).href;
// The case starts a node process that loads the source tree: slow on a busy machine.
vi.setConfig({ testTimeout: 90_000 });

const alive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
};

const groups: number[] = [];
afterEach(() => {
	for (const pid of groups.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

const SESSION = `
import fs from "node:fs";
import { BashJobs } from ${JSON.stringify(JOBS)};
const [mode, dir, out] = process.argv.slice(2);
const job = await new BashJobs(dir).start("sleep 60", dir, undefined, () => {});
fs.writeFileSync(out, String(job.pid));
if (mode === "crash") setTimeout(() => { throw new Error("crash"); });
else process.exit(1);
`;

describe.runIf(process.platform !== "win32")("background bash job at exit", () => {
	for (const mode of ["exit", "crash"]) {
		it(`kills the job's process group on ${mode} without a session shutdown`, async () => {
			const dir = tmp("octocode-job-exit-");
			const script = path.join(dir, "session.mjs");
			const out = path.join(dir, "pid");
			fs.writeFileSync(script, SESSION);
			const session = spawn(process.execPath, ["--import", SOURCE_RESOLVER, script, mode, dir, out], {
				stdio: "ignore",
			});
			await new Promise((resolve) => session.on("exit", resolve));
			const pid = Number(fs.readFileSync(out, "utf8"));
			groups.push(pid);
			expect(pid).toBeGreaterThan(0);
			await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
		});
	}
});
