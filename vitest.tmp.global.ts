import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GUARD_FILE_ENV,
	guardRecords,
	isolateHome,
	makeRunDir,
	stopRunProcesses,
	sweepStaleRunDirs,
	sweepStaleTmuxSockets,
} from "./test-isolation.ts";

/**
 * Isolates each test run before its first worker starts, so every test and every process a test starts inherits it:
 * its own temporary directory (TMPDIR), its own home (HOME, XDG_*, OCTOCODE_HOME, OCTOCODE_CODING_AGENT_DIR,
 * OCTOCODE_AGENT_DB) unless the run already came with one (`./test.sh`), and the guard file that `agentDbPath` records a
 * refusal of the real agent database in, from any process of the run (`test-isolation.ts`).
 *
 * At teardown it stops the processes the run left running (they carry the guard file in their environment) and fails
 * the run for a web daemon that outlived it or a refusal in the guard file, then removes the run's folders. Vitest stops
 * its workers without running their `process.on("exit")` handlers, so cleanup registered inside a test process does not
 * happen. A run that was killed before its teardown leaves its folders, which the next run removes once their owner is
 * gone; so are the e2e suites' tmux sockets whose test process is gone, at both ends of a run. The run's home (`VITEST_TEST_USER_HOME`) sits beside the temporary directory, never inside it: the folder trust
 * gate ignores a trusted subtree that contains the home folder, and tests trust the temporary directory.
 */
export default async function setup(): Promise<() => Promise<void>> {
	const parent = tmpdir();
	await sweepStaleRunDirs(parent);
	sweepStaleTmuxSockets();
	const dir = makeRunDir(parent);
	const userHome = makeRunDir(parent);
	isolateHome(process.env, () => userHome);
	process.env.VITEST_TEST_USER_HOME = userHome;
	process.env.TMPDIR = dir;
	process.env.TEMP = dir;
	process.env.TMP = dir;
	const guardFile = join(dir, "real-home-opens.log");
	process.env[GUARD_FILE_ENV] = guardFile;
	// No process of the run opens a browser window on this machine (`OPEN_BROWSER_ENV`, `browser/app-window.ts`).
	process.env.OCTOCODE_OPEN_BROWSER = "0";
	return async () => {
		const { daemons, others } = await stopRunProcesses(`${GUARD_FILE_ENV}=${guardFile}`);
		const opened = guardRecords(guardFile);
		for (const each of [dir, userHome]) rmSync(each, { recursive: true, force: true, maxRetries: 3 });
		sweepStaleTmuxSockets();
		if (others.length > 0)
			process.stderr.write(
				["Stopped processes the tests left running (pid, command):", ...others.map(describe), ""].join("\n"),
			);
		if (daemons.length === 0 && opened.length === 0) return;
		// Vitest reports a teardown error but exits 0, so the exit code is set here.
		process.exitCode = 1;
		throw new Error(
			[
				...(opened.length > 0
					? ["Tests resolved the real agent database or provider configuration (file, pid, caller):", ...opened]
					: []),
				...(daemons.length > 0
					? ["Web daemons outlived the run (stopped now; pid, command):", ...daemons.map(describe)]
					: []),
				"Isolate HOME/OCTOCODE_HOME in the test and stop what it starts.",
			].join("\n"),
		);
	};
}

const describe = ({ pid, command }: { pid: number; command: string }) => `${pid}\t${command}`;
