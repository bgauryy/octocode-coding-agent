import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Processes from "../../src/octocode/shared/process.ts";
import { groupStartTimes } from "../../src/octocode/shared/process.ts";
import { leftBehind } from "../../src/octocode/subagents/process/left-behind.ts";

vi.mock("../../src/octocode/shared/process.ts", async (original) => {
	const real = await original<typeof Processes>();
	return { ...real, groupStartTimes: vi.fn(real.groupStartTimes) };
});

/** Runs `script` with sh as the leader of a process group of its own and waits for the leader to exit. */
async function exitedGroup(script: string): Promise<number> {
	const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
	await once(child, "exit");
	return child.pid!;
}

const groups: number[] = [];
afterEach(() => {
	for (const pgid of groups.splice(0))
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Already gone.
		}
	vi.mocked(groupStartTimes).mockClear();
});

describe.skipIf(process.platform === "win32")("what an exited child left in its process group", () => {
	it("finds nothing in an empty group without running ps", async () => {
		const pgid = await exitedGroup("exit 0");
		expect(await leftBehind(pgid)).toBe(false);
		expect(groupStartTimes).not.toHaveBeenCalled();
	});

	it("asks ps when the group still has a member, and finds it", async () => {
		const pgid = await exitedGroup("sleep 30 & exit 0");
		groups.push(pgid);
		expect(await leftBehind(pgid)).toBe(true);
		expect(groupStartTimes).toHaveBeenCalledTimes(1);
	});
});

describe("Windows, where a job outlives its root", () => {
	afterEach(() => vi.restoreAllMocks());

	it("always reports the job for cleanup and never probes a process group", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		expect(await leftBehind(4242)).toBe(true);
		expect(groupStartTimes).not.toHaveBeenCalled();
	});

	it("has nothing to clean without a pid", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		expect(await leftBehind(undefined)).toBe(false);
	});
});
