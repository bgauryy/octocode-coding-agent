import type { ChildProcess } from "node:child_process";
import type * as shellModule from "../../src/utils/shell.ts";
import type * as processModule from "../../src/octocode/shared/process.ts";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { tmp } from "./helpers.ts";

vi.mock("../../src/utils/shell.ts", async (actual) => ({
	...(await actual<typeof shellModule>()),
	spawnShell: vi.fn(),
}));
vi.mock("../../src/octocode/shared/process.ts", async (actual) => ({
	...(await actual<typeof processModule>()),
	killTree: vi.fn(),
}));
vi.resetModules();
const { spawnShell } = await import("../../src/utils/shell.ts");
const { killTree } = await import("../../src/octocode/shared/process.ts");
const { BashJobs } = await import("../../src/octocode/files/bash-jobs.ts");

afterEach(() => vi.restoreAllMocks());

function child() {
	return Object.assign(new EventEmitter(), {
		pid: 7654321,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		unref: vi.fn(),
	});
}

it("stops a spawned tree and closes its pipes when opening the job log fails", async () => {
	const running = child();
	vi.mocked(spawnShell).mockResolvedValue(running as unknown as ChildProcess);
	const jobs = new BashJobs(tmp());
	const open = fs.openSync;
	vi.spyOn(fs, "openSync").mockImplementation((...args) => {
		if (String(args[0]).endsWith(".log")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		return open(...args);
	});
	await expect(jobs.start("server", tmp(), undefined, vi.fn())).rejects.toThrow("disk full");
	expect(killTree).toHaveBeenCalledWith(running.pid);
	expect(jobs.running()).toEqual([]);
	expect([running.stdin, running.stdout, running.stderr].every((pipe) => pipe.destroyed)).toBe(true);
	expect(running.unref).toHaveBeenCalledOnce();
});

it("stops an adopted tree if its storage directory cannot be created", () => {
	const running = child();
	const dir = path.join(tmp(), "not-a-directory");
	fs.writeFileSync(dir, "file");
	const jobs = new BashJobs(path.join(dir, "logs"));
	expect(() =>
		jobs.adopt(running as unknown as ChildProcess, "server", tmp(), vi.fn(), {
			output: Buffer.alloc(0),
			startedAt: Date.now(),
		}),
	).toThrow();
	expect(killTree).toHaveBeenCalledWith(running.pid);
	expect(jobs.running()).toEqual([]);
	expect([running.stdin, running.stdout, running.stderr].every((pipe) => pipe.destroyed)).toBe(true);
});
