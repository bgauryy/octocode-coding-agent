import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	agentDbPath,
	TEST_GUARD_FILE_ENV,
	TEST_PROTECTED_HOMES_ENV,
	transcriptDbPath,
} from "../../src/storage/state-paths.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { daemonSpawnOptions } from "../../src/octocode/web-daemon/spawn-env.ts";
import { tmp } from "./helpers.ts";

const child = fileURLToPath(new URL("./real-home-guard-child.ts", import.meta.url));
const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;

describe("the real agent database under a test runner", () => {
	it("is refused, and the refusal is recorded so a caller that swallows it still fails the run", () => {
		const record = path.join(tmp(), "opens.log");
		// The account's real Octocode home, from the user database: a test's HOME does not move it.
		const realHome = path.join(os.userInfo().homedir, ".octocode", "octocodecode");
		expect(() => agentDbPath({ OCTOCODE_HOME: realHome, [TEST_GUARD_FILE_ENV]: record })).toThrow(
			/A test resolved the real agent database/,
		);
		expect(fs.readFileSync(record, "utf8")).toContain(path.join(realHome, "agent", "workspaces.db"));
	});

	it("leaves a test's own home alone", () => {
		const home = tmp();
		expect(agentDbPath({ OCTOCODE_HOME: home })).toBe(path.join(home, "agent", "workspaces.db"));
	});

	it("is refused in a child that kept only a daemon's environment, for a home the run protects", () => {
		// A stand-in for the developer's home: the run protects it like the account's, so the child treats it as real.
		const fakeHome = tmp("fake-real-home-");
		const record = path.join(tmp(), "opens.log");
		const launching: NodeJS.ProcessEnv = {
			...process.env,
			HOME: fakeHome,
			[TEST_GUARD_FILE_ENV]: record,
			[TEST_PROTECTED_HOMES_ENV]: fakeHome,
		};
		for (const name of ["OCTOCODE_HOME", "OCTOCODE_AGENT_DB", "OCTOCODE_CODING_AGENT_DIR"]) delete launching[name];
		// What a detached web daemon gets: no VITEST or NODE_TEST_CONTEXT, but the run's OCTOCODE_TEST_* markers.
		const { env } = daemonSpawnOptions(launching);
		expect(env.VITEST).toBeUndefined();
		expect(env.NODE_TEST_CONTEXT).toBeUndefined();
		expect(env[TEST_GUARD_FILE_ENV]).toBe(record);
		const run = (childEnv: NodeJS.ProcessEnv) =>
			spawnSync(process.execPath, ["--import", resolver, child], { env: childEnv, cwd: tmp(), encoding: "utf8" });
		const expected = path.join(fakeHome, ".octocode", "octocodecode", "agent", "workspaces.db");

		const refused = run(env);
		expect(refused.status, refused.stderr).toBe(3);
		expect(refused.stderr).toContain(`A test resolved the real agent database (${expected})`);
		const [file, pid] = fs.readFileSync(record, "utf8").trim().split("\t");
		expect(file).toBe(expected);
		expect(Number(pid)).toBe(refused.pid);

		// Without the run's marker the same child is an ordinary process: the guard is what refused it.
		const unmarked = { ...env };
		delete unmarked[TEST_GUARD_FILE_ENV];
		delete unmarked[TEST_PROTECTED_HOMES_ENV];
		const ordinary = run(unmarked);
		expect(ordinary.status, ordinary.stderr).toBe(0);
		expect(ordinary.stdout).toBe(expected);
		expect(fs.existsSync(path.join(fakeHome, ".octocode"))).toBe(false);
	});

	it("is not refused in an Octocode a user starts from their own test harness, without this repository's markers", () => {
		const home = tmp("user-harness-home-");
		const record = path.join(tmp(), "opens.log");
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, VITEST: "true", NODE_TEST_CONTEXT: "child-v8" };
		for (const name of ["OCTOCODE_HOME", "OCTOCODE_AGENT_DB", "OCTOCODE_CODING_AGENT_DIR", TEST_PROTECTED_HOMES_ENV])
			delete env[name];
		env[TEST_GUARD_FILE_ENV] = "";
		// The account's real home: what a user's own process resolves. Only resolved, never opened.
		const realDb = path.join(os.userInfo().homedir, ".octocode", "octocodecode", "agent", "workspaces.db");
		env.OCTOCODE_HOME = path.dirname(path.dirname(realDb));
		const run = (childEnv: NodeJS.ProcessEnv) =>
			spawnSync(process.execPath, ["--import", resolver, child], { env: childEnv, cwd: tmp(), encoding: "utf8" });
		const ordinary = run(env);
		expect(ordinary.status, ordinary.stderr).toBe(0);
		expect(ordinary.stdout).toBe(realDb);
		// The same child with this run's marker is refused: the marker, not the runner, decides.
		const marked = run({ ...env, [TEST_GUARD_FILE_ENV]: record });
		expect(marked.status, marked.stderr).toBe(3);
		expect(fs.readFileSync(record, "utf8")).toContain(realDb);
	});
});

describe("the transcript mirror's file", () => {
	it("is refused with its coordination file when a test names the real home's database directly", () => {
		// A stand-in for the developer's home, protected like the account's; nothing is created under it.
		const fakeHome = tmp("fake-real-home-");
		const record = path.join(tmp(), "opens.log");
		const env = { ...process.env, [TEST_GUARD_FILE_ENV]: record, [TEST_PROTECTED_HOMES_ENV]: fakeHome };
		const real = path.join(fakeHome, ".octocode", "octocodecode", "agent", "workspaces.db");
		expect(() => openAgentDb(real, env)).toThrow(/A test resolved the real agent database/);
		expect(fs.readFileSync(record, "utf8")).toContain(real);
		expect(fs.existsSync(path.join(fakeHome, ".octocode"))).toBe(false);
		// The mirror beside a test's own file is that test's.
		const own = path.join(tmp(), "agent.db");
		openAgentDb(own, env).close();
		expect(fs.existsSync(own)).toBe(true);
	});

	it("sits beside the coordination file, named after it unless it is the default `workspaces.db`", () => {
		expect(transcriptDbPath("/h/agent/workspaces.db")).toBe("/h/agent/transcripts.db");
		expect(transcriptDbPath("/x/lifecycle.db")).toBe("/x/lifecycle.transcripts.db");
	});
});
