import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { runSubagent, STARTUP_RETRY_ENV } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

// The child is the fake Octocode host (`subagent-fake-host.cjs`), run with node.
vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-settle-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	for (const key of [
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
		STARTUP_RETRY_ENV,
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

/** Runs a fake child to its end, recording when the run's `settled` and `exited` hooks fire against its resolution. */
async function hooked(task: string, throwing = false) {
	const events: string[] = [];
	const id = `a-${task.replace(/\W+/g, "-")}`;
	const outcome = await runSubagent({
		task,
		args: ["--session-dir", tmp(), "--session-id", id],
		cwd: tmp(),
		identity: { id, scratch: tmp() },
		onProgress: () => undefined,
		settled: () => {
			events.push("settled");
			if (throwing) throw new Error("hint failed");
		},
		exited: () => {
			events.push("exited");
			if (throwing) throw new Error("hint failed");
		},
	});
	events.push("resolved");
	return { outcome, events };
}

describe.skipIf(process.platform === "win32")("the hooks a run gives its caller", () => {
	it("says the run settled before the child exits, then that it exited, and the run resolves after both", async () => {
		const { outcome, events } = await hooked("unpriced answer");
		expect(outcome.error).toBeUndefined();
		expect(events).toEqual(["settled", "exited", "resolved"]);
	}, 20_000);

	it("keeps the report of a child that crashes after it settled", async () => {
		const { outcome, events } = await hooked("settle then crash");
		expect(outcome.text).toContain("SETTLED REPORT");
		expect(outcome.error).toBeUndefined();
		expect(events).toEqual(["settled", "exited", "resolved"]);
	}, 20_000);

	it("ignores a hook that throws: the run and its report are unaffected", async () => {
		const { outcome, events } = await hooked("settle then crash", true);
		expect(outcome.text).toContain("SETTLED REPORT");
		expect(events).toEqual(["settled", "exited", "resolved"]);
	}, 20_000);

	it("gives the caller a working probe: true while the child runs, false once it exited, with a change hint", async () => {
		const seen: boolean[] = [];
		let probe: (() => boolean) | undefined;
		let changes = 0;
		const outcome = await runSubagent({
			task: "unpriced answer",
			args: ["--session-dir", tmp(), "--session-id", "a-working-probe"],
			cwd: tmp(),
			identity: { id: "a-working-probe", scratch: tmp() },
			onProgress: () => undefined,
			working: (each) => {
				probe = each;
				seen.push(each());
			},
			workingChanged: () => changes++,
			settled: () => seen.push(probe?.() ?? false),
		});
		expect(outcome.error).toBeUndefined();
		// Working at start and still at its settle (it has not exited yet); not once it is gone.
		expect(seen).toEqual([true, true]);
		expect(probe?.()).toBe(false);
		expect(changes).toBeGreaterThan(0);
	}, 20_000);

	it("after the child settled, its probe says its report is on its way through exit and cleanup, until the run concludes", async () => {
		let probe: (() => boolean) | undefined;
		let atExit: boolean | undefined;
		const outcome = await runSubagent({
			task: "unpriced answer",
			args: ["--session-dir", tmp(), "--session-id", "a-building-probe"],
			cwd: tmp(),
			identity: { id: "a-building-probe", scratch: tmp() },
			onProgress: () => undefined,
			working: (each) => (probe = each),
			exited: () => (atExit = probe?.()),
		});
		expect(outcome.error).toBeUndefined();
		// Gone, but its sibling reports still wait for its report: the run has not concluded yet.
		expect(atExit).toBe(true);
		expect(probe?.()).toBe(false);
	}, 20_000);

	it("says nothing settled for a child that crashes before its answer, but still that it exited", async () => {
		const events: string[] = [];
		await expect(
			runSubagent({
				task: "fail",
				args: [],
				cwd: tmp(),
				identity: { id: "a-fail-hooks", scratch: tmp() },
				onProgress: () => undefined,
				settled: () => events.push("settled"),
				exited: () => events.push("exited"),
			}),
		).rejects.toThrow();
		expect(events).toEqual(["exited"]);
	}, 20_000);
});
