import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/** A session write under a lock another process holds must not stall this process's event loop. */

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../scripts/source-resolver.ts")).href;
const sharedFileUrl = pathToFileURL(resolve(__dirname, "../../src/core/session-manager/shared-file.ts")).href;

let dir: string;
let session: SessionManager;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-lock-loop-"));
	session = SessionManager.create(dir, dir);
	session.appendMessage(userMsg("hello"));
	session.appendMessage(assistantMsg("hi"));
	file = session.getSessionFile()!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Starts a child that holds the lock until `release()` (or for 20 s, so a failed test leaves nothing behind); resolves
 * once it holds it. Released on a signal, not a timer, so "still held" never depends on how busy the machine is.
 */
async function holdLock(): Promise<{ release: () => void; stop: () => Promise<void> }> {
	const script = join(dir, "hold.mjs");
	writeFileSync(
		script,
		`const { lockSessionFile } = await import(${JSON.stringify(sharedFileUrl)});
const release = lockSessionFile(process.argv[2]);
process.stdout.write("held\\n");
const done = () => { release(); process.exit(0); };
process.stdin.once("data", done);
setTimeout(done, 20_000);
`,
	);
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, script, file], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	await new Promise<void>((done) => child.stdout.once("data", () => done()));
	return {
		release: () => child.stdin.write("release\n"),
		stop: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
}

describe("a session append while another process holds the lock", () => {
	// Measured by what happens, not by how late a timer fires: load delays every timer, a wait for the lock stops them.
	it("keeps this process's timers on schedule and writes the record afterwards", async () => {
		const holder = await holdLock();
		const written = () => readFileSync(file, "utf8").includes("during the hold");
		let ticksWhileHeld = 0;
		let released = false;
		const timer = setInterval(() => {
			if (!released && !written()) ticksWhileHeld++;
		}, 5);
		// The lock wait blocks this thread only by sleeping between tries (`Atomics.wait`): the append must not sleep.
		const sleeps = vi.spyOn(Atomics, "wait");
		try {
			session.appendMessage(userMsg("during the hold"));
			expect(sleeps).not.toHaveBeenCalled();
			sleeps.mockRestore();
			// Timers keep running while the other process holds the lock, and the record waits in memory meanwhile.
			await vi.waitUntil(() => ticksWhileHeld >= 10, { timeout: 10_000 });
			expect(written()).toBe(false);
			released = true;
			holder.release();
			// The held record reaches disk once the lock is free (the retry backs off up to 2 s between tries).
			await vi.waitUntil(async () => (await readFile(file, "utf8")).includes("during the hold"), { timeout: 10_000 });
		} finally {
			sleeps.mockRestore();
			clearInterval(timer);
			await holder.stop();
		}
		expect(ticksWhileHeld).toBeGreaterThanOrEqual(10);
		expect(readFileSync(file, "utf8")).toContain("during the hold");
	});
});
