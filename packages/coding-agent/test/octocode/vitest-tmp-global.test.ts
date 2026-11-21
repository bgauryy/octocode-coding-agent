import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GUARD_FILE_ENV,
	isolateHome,
	PROTECTED_HOMES_ENV,
	runProcesses,
	staleRunOrphans,
	sweepStaleTmuxSockets,
} from "../../../../test-isolation.ts";
import setup from "../../../../vitest.tmp.global.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";

const child = fileURLToPath(new URL("./real-home-guard-child.ts", import.meta.url));
const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const accountHome = os.userInfo().homedir;

/** setup() isolates the whole process environment; each test gets the worker's back, and its exit code. */
let savedEnv: NodeJS.ProcessEnv;
let savedExitCode: typeof process.exitCode;
let parent: string;
beforeEach(() => {
	savedEnv = { ...process.env };
	savedExitCode = process.exitCode;
	parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vt-parent-"));
	process.env.TMPDIR = parent;
});
afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
	Object.assign(process.env, savedEnv);
	process.exitCode = savedExitCode;
	fs.rmSync(parent, { recursive: true, force: true });
});

function root(name: string, pid: number): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, ".owner-pid"), String(pid));
	return dir;
}

describe("the test runs' temporary root", () => {
	it("sweeps a root whose owner is gone, keeps a live owner's and an unrelated folder, and removes its own at teardown", async () => {
		const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout);
		const stale = root("vt-stale", dead);
		const live = root("vt-live", process.pid);
		const unrelated = path.join(parent, "other");
		fs.mkdirSync(unrelated);

		const teardown = setup();
		const own = process.env.TMPDIR as string;
		const home = process.env.VITEST_TEST_USER_HOME as string;
		expect(path.dirname(own)).toBe(parent);
		expect(own.startsWith(path.join(parent, "vt-"))).toBe(true);
		// The run's home sits beside its temporary directory, never inside it.
		expect(path.dirname(home)).toBe(parent);
		expect(home).not.toBe(own);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(fs.readFileSync(path.join(own, ".owner-pid"), "utf8")).toBe(String(process.pid));
		expect(process.env[GUARD_FILE_ENV]).toBe(path.join(own, "real-home-opens.log"));

		await teardown();
		expect(fs.existsSync(own)).toBe(false);
		expect(fs.existsSync(home)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
	});
});

describe("the run's home", () => {
	it("replaces the developer's home and every folder that falls back to it", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: accountHome,
			XDG_CONFIG_HOME: path.join(accountHome, ".config"),
			XDG_DATA_HOME: path.join(accountHome, ".local", "share"),
			OCTOCODE_HOME: "/elsewhere/octocode",
			CLAUDE_CONFIG_DIR: path.join(accountHome, ".claude"),
		};
		const home = path.join(parent, "home");
		const result = isolateHome(env, () => home);
		const octocodeHome = path.join(home, ".octocode", "octocodecode");
		expect(result.kept).toBe(false);
		expect(env).toEqual({
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			OCTOCODE_HOME: octocodeHome,
			OCTOCODE_CODING_AGENT_DIR: octocodeHome,
			OCTOCODE_AGENT_DB: path.join(octocodeHome, "agent", "workspaces.db"),
			[PROTECTED_HOMES_ENV]: accountHome,
		});
	});

	it("keeps a home the run came with (./test.sh), replacing only a variable that still names a protected home", () => {
		const own = path.join(parent, "test-sh-home");
		const env: NodeJS.ProcessEnv = {
			HOME: own,
			XDG_CONFIG_HOME: path.join(own, ".config"),
			OCTOCODE_AGENT_DB: path.join(accountHome, ".octocode", "octocodecode", "agent", "workspaces.db"),
			[PROTECTED_HOMES_ENV]: "/outer/run/home",
		};
		const made = vi.fn(() => path.join(parent, "unused"));
		const result = isolateHome(env, made);
		expect(made).not.toHaveBeenCalled();
		expect(result).toEqual({ kept: true, protectedHomes: [accountHome, "/outer/run/home"] });
		expect(env.HOME).toBe(own);
		expect(env.XDG_CONFIG_HOME).toBe(path.join(own, ".config"));
		expect(env.OCTOCODE_AGENT_DB).toBe(path.join(own, ".octocode", "octocodecode", "agent", "workspaces.db"));
		expect(env.OCTOCODE_HOME).toBeUndefined();
	});
});

describe("the run's teardown", () => {
	it("fails the run for a child that resolved a protected home's database and for a daemon that outlived it, and stops both", async () => {
		// A stand-in for the developer's home that the run protects, as an outer run's list would name it.
		const fakeHome = fs.mkdtempSync(path.join(parent, "fake-real-home-"));
		process.env[PROTECTED_HOMES_ENV] = fakeHome;
		const teardown = setup();
		const marker = `${GUARD_FILE_ENV}=${process.env[GUARD_FILE_ENV]}`;

		const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
		for (const name of ["VITEST", "OCTOCODE_HOME", "OCTOCODE_AGENT_DB", "OCTOCODE_CODING_AGENT_DIR"])
			delete childEnv[name];
		const refused = spawnSync(process.execPath, ["--import", resolver, child], {
			env: childEnv,
			cwd: parent,
			encoding: "utf8",
		});
		expect(refused.status, refused.stderr).toBe(3);

		// A daemon and a helper process the tests forgot: started detached by a launcher that then exits, like the real
		// daemon, so they belong to no worker, with the run's environment.
		const launch = `const { spawn } = require("node:child_process");
			const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], { detached: true, stdio: "ignore" });
			process.stdout.write(String(proc.pid)); proc.unref();`;
		const forgotten = (arg: string) =>
			Number(spawnSync(process.execPath, ["-e", launch, arg], { env: process.env, encoding: "utf8" }).stdout);
		const daemon = forgotten("__web-daemon");
		const helper = forgotten("helper");
		await vi.waitFor(() => expect(runProcesses(marker).map((each) => each.pid)).toContain(helper));

		const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const failure = await teardown().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(String(failure)).toContain("Tests resolved the real agent database");
			expect(String(failure)).toContain(path.join(fakeHome, ".octocode", "agent", "workspaces.db"));
			expect(String(failure)).toContain(`Web daemons outlived the run (stopped now; pid, command):\n${daemon}\t`);
			expect(String(failure)).not.toContain(`${helper}\t`);
			expect(warn.mock.calls.flat().join("\n")).toContain(`${helper}\t`);
			expect(process.exitCode).toBe(1);
		} finally {
			warn.mockRestore();
			for (const pid of [daemon, helper]) if (processAlive(pid)) process.kill(pid, "SIGKILL");
		}
		await vi.waitFor(() => expect([daemon, helper].filter(processAlive)).toEqual([]));
	});
});

describe.skipIf(process.platform === "win32")("e2e tmux sockets", () => {
	it("stops and removes those of a gone test process, keeping a live one's and others", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-")));
		// A pid past the system's range never runs.
		const dead = "999999999";
		const live = `octo-e2e-${process.pid}-0`;
		const kept = [live, `octo-reach-${process.pid}`, "octo-defects-olive", `octo-e2e-${dead}-x`];
		const stale = [`octo-e2e-${dead}-0`, `octo-reach-${dead}`];
		for (const name of [...kept, ...stale]) fs.writeFileSync(path.join(dir, name), "");
		const server = path.join(dir, `octo-e2e-${dead}-1`);
		const tmux = spawnSync("tmux", ["-S", server, "-f", "/dev/null", "new-session", "-d", "sleep 60"]).status === 0;
		try {
			const removed = sweepStaleTmuxSockets(dir);
			expect(removed.sort()).toEqual([...stale, ...(tmux ? [path.basename(server)] : [])].sort());
			expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort());
			if (tmux) expect(spawnSync("tmux", ["-S", server, "list-sessions"]).status).not.toBe(0);
		} finally {
			spawnSync("tmux", ["-S", server, "kill-server"]);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("orphans of a run killed before its teardown", () => {
	it("names orphaned processes of dead or deleted runs, leaving live runs and processes with a living parent", () => {
		const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-")));
		try {
			const dead = path.join(parent, "vt-dead01");
			const live = path.join(parent, "vt-live01");
			fs.mkdirSync(dead);
			fs.mkdirSync(live);
			// A pid past the system's range never runs; this process owns the live run.
			fs.writeFileSync(path.join(dead, ".owner-pid"), "999999999");
			fs.writeFileSync(path.join(live, ".owner-pid"), String(process.pid));
			const listing = [
				// tmux started with `env -i`: only its command line names the dead run.
				`  101     1   101 tmux -L octo-e2e-1-0 new-session -c ${dead}/project`,
				// A child of the dead run whose folder the sweep already removed.
				`  102     1   102 node ${parent}/vt-gone01/worker.mjs --mode rpc`,
				// Its marker in the environment only.
				`  103     1    90 node -e x OCTOCODE_TEST_GUARD_FILE=${dead}/real-home-opens.log`,
				// Still parented: something alive owns it.
				`  104   555   104 node ${dead}/child.mts`,
				// The live run's orphan, such as a web daemon it started.
				`  105     1   105 node ${live}/daemon.mjs`,
				// Names both: it belongs to the live run as well.
				`  106     1   106 node ${dead}/a ${live}/b`,
				// Not a test run's folder.
				"  107     1   107 tmux new-session -d -s octoux",
			].join("\n");
			expect(staleRunOrphans(parent, listing)).toEqual([
				[101, 101],
				[102, 102],
				[103, 90],
			]);
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});
});
