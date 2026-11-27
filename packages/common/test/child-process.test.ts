import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { waitForChildProcess } from "../src/child-process.ts";

/** Exits at once and leaves a process in its group writing to the inherited output every 20 ms. */
const startWithWriter = () =>
	spawn("sh", ["-c", "(while :; do echo x; sleep 0.02; done) & exit 3"], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
const stopGroup = (pid: number | undefined) => {
	try {
		process.kill(-pid!, "SIGKILL");
	} catch {
		// Already gone.
	}
};
const pendingAfter = (wait: Promise<unknown>, ms: number): Promise<boolean> =>
	Promise.race([wait.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms))]);

describe.skipIf(process.platform === "win32")("waitForChildProcess with a writer still holding the pipes", () => {
	it("keeps reading while output arrives", async () => {
		const child = startWithWriter();
		const wait = waitForChildProcess(child);
		try {
			expect(await pendingAfter(wait, 500)).toBe(true);
		} finally {
			stopGroup(child.pid);
		}
		expect(await wait).toBe(3);
	});

	it("ends one grace after giveUp fires, whatever still arrives", async () => {
		const child = startWithWriter();
		const giveUp = new AbortController();
		const wait = waitForChildProcess(child, giveUp.signal);
		try {
			expect(await pendingAfter(wait, 400)).toBe(true);
			giveUp.abort();
			expect(await pendingAfter(wait, 1_000)).toBe(false);
			expect(await wait).toBe(3);
		} finally {
			stopGroup(child.pid);
		}
	});

	it("ends one grace after the exit when giveUp fired first", async () => {
		const child = spawn("sh", ["-c", "(while :; do echo x; sleep 0.02; done) & sleep 0.3; exit 3"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const giveUp = new AbortController();
		giveUp.abort();
		const wait = waitForChildProcess(child, giveUp.signal);
		try {
			expect(await pendingAfter(wait, 1_500)).toBe(false);
			expect(await wait).toBe(3);
		} finally {
			stopGroup(child.pid);
		}
	});
});
