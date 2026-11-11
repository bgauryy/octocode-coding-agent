import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { foregroundOperations } from "../../src/octocode/files/bash-run.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { SHELL_GROUPS_FILE_ENV } from "../../src/octocode/shared/shell-groups.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

// The child is a stand-in script run with node (`process.argv[1]`, set per test).
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const savedArgv = process.argv[1];
afterEach(() => {
	process.argv[1] = savedArgv!;
	delete process.env[SHELL_GROUPS_FILE_ENV];
	delete process.env.TEST_SHELL_PID_FILE;
});

/**
 * A child that starts a bash command as `bash` does (a shell leading its own process group), lists it where its parent
 * asked (`SHELL_GROUPS_FILE_ENV`), and is then killed with SIGKILL, so nothing in it can stop the command.
 */
const CRASH_MID_BASH = `
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const shell = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
shell.unref();
const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(shell.pid)], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
}).trim().replace(/\\s+/g, ' ');
const m = /^\\w{3} (\\w{3}) +(\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$/.exec(lstart);
const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[1]);
const started = String(Date.UTC(+m[6], month, +m[2], +m[3], +m[4], +m[5]) / 1000);
fs.appendFileSync(process.env.${SHELL_GROUPS_FILE_ENV}, JSON.stringify({ pid: shell.pid, started }) + '\\n');
fs.writeFileSync(process.env.TEST_SHELL_PID_FILE, String(shell.pid));
const event = { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 30' } };
fs.writeSync(1, JSON.stringify(event) + '\\n');
process.kill(process.pid, 'SIGKILL');
`;

describe.skipIf(process.platform === "win32")("a subagent that dies mid-bash", () => {
	it("has its bash command's process group stopped by the parent before the run settles, and says what it was doing", async () => {
		const dir = tmp();
		const script = path.join(dir, "octocode");
		fs.writeFileSync(script, CRASH_MID_BASH);
		process.argv[1] = script;
		const pidFile = path.join(dir, "shell.pid");
		process.env.TEST_SHELL_PID_FILE = pidFile;
		let shell = 0;
		try {
			await expect(
				runSubagent({
					task: "go",
					args: [],
					cwd: tmp(),
					identity: { id: "a-crash-bash", scratch: tmp() },
					onProgress: () => undefined,
				}),
			).rejects.toThrow(/killed by SIGKILL[\s\S]*\nLast tool call: → bash .*sleep 30.* \(still running\)/);
			shell = Number(fs.readFileSync(pidFile, "utf8"));
			expect(shell).toBeGreaterThan(0);
			// The run has settled: the command the dead child left running is already gone.
			expect(processAlive(shell)).toBe(false);
		} finally {
			try {
				if (shell) process.kill(-shell, "SIGKILL");
			} catch {
				/* Already gone. */
			}
		}
	}, 20_000);

	it("lists each foreground bash command's group in the file its parent named", async () => {
		const file = path.join(tmp(), "shell-groups.jsonl");
		process.env[SHELL_GROUPS_FILE_ENV] = file;
		const operations = foregroundOperations({}, () => undefined);
		await operations.exec("sleep 0.3", tmp(), { onData: () => undefined });
		const [line] = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(JSON.parse(line)).toEqual({ pid: expect.any(Number), started: expect.stringMatching(/^\d+$/) });
	});
});
