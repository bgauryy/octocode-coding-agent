import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { lockSessionFile, withSessionFileLock } from "../../src/core/session-manager/shared-file.ts";
import { userMsg } from "../utilities.ts";

/**
 * A process killed while it holds a session's lock leaves `<file>.lock` behind. Its owner record (pid, host, start time,
 * lock directory) lets the next writer take the lock at once when that owner is verifiably gone; a live or unknown
 * owner is still waited for.
 */

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../scripts/source-resolver.ts")).href;
const sharedFileUrl = pathToFileURL(resolve(__dirname, "../../src/core/session-manager/shared-file.ts")).href;

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-stale-lock-"));
	const seed = SessionManager.create(dir, dir);
	seed.appendMessage(userMsg("hello"));
	file = seed.getSessionFile()!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A child that takes the session lock, says so, and then waits to be killed. */
async function childHoldingLock(): Promise<{ pid: number; kill: () => Promise<void> }> {
	const script = join(dir, "hold.mjs");
	writeFileSync(
		script,
		`const { lockSessionFile } = await import(${JSON.stringify(sharedFileUrl)});
// The owner's start time is read in the background at the first lock: let it land, as in a long-running session.
lockSessionFile(process.argv[2] + ".probe")();
setTimeout(() => {
	lockSessionFile(process.argv[2]);
	process.stdout.write("held\\n");
}, 1500);
setInterval(() => {}, 1000);
`,
	);
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, script, file], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise<void>((done) => child.stdout.once("data", () => done()));
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	return {
		pid: child.pid!,
		kill: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
}

const timed = <T>(work: () => T): { value: T; ms: number } => {
	const started = performance.now();
	const value = work();
	return { value, ms: performance.now() - started };
};

describe("a session lock whose holder was killed", () => {
	it("records the holder beside the lock and removes the record with the lock", () => {
		const release = lockSessionFile(file);
		const owner = JSON.parse(readFileSync(`${file}.lock.owner`, "utf8"));
		expect(owner).toMatchObject({ pid: process.pid });
		expect(typeof owner.dir).toBe("string");
		release();
		expect(existsSync(`${file}.lock`)).toBe(false);
		expect(existsSync(`${file}.lock.owner`)).toBe(false);
	});

	it("is taken at once, and the next write works", async () => {
		const holder = await childHoldingLock();
		try {
			const owner = JSON.parse(readFileSync(`${file}.lock.owner`, "utf8"));
			expect(owner.pid).toBe(holder.pid);
			expect(owner.started).toMatch(/^\d+$/);
			await holder.kill();
			expect(existsSync(`${file}.lock`)).toBe(true);

			const { ms } = timed(() => withSessionFileLock(file, () => undefined));
			expect(ms).toBeLessThan(500);
			const manager = SessionManager.open(file, dir);
			const { ms: appendMs } = timed(() => manager.appendMessage(userMsg("after the kill")));
			expect(appendMs).toBeLessThan(500);
			expect(SessionManager.open(file, dir).getEntries()).toHaveLength(2);
		} finally {
			await holder.kill();
		}
	}, 20_000);

	it("is still waited for while its holder lives", async () => {
		const holder = await childHoldingLock();
		try {
			expect(() => withSessionFileLock(file, () => undefined, 300)).toThrow(/already being held/);
		} finally {
			await holder.kill();
		}
	}, 20_000);

	it("is waited for when the record names a live process that cannot be told apart, or another lock directory", () => {
		const release = lockSessionFile(file);
		const record = JSON.parse(readFileSync(`${file}.lock.owner`, "utf8"));
		try {
			// The test runner's parent is alive; without a start time nothing proves it is not the owner.
			writeFileSync(`${file}.lock.owner`, JSON.stringify({ ...record, pid: process.ppid, started: undefined }));
			expect(() => withSessionFileLock(file, () => undefined, 100)).toThrow(/already being held/);
			// A dead pid, but the record describes a lock directory that is not this one.
			writeFileSync(`${file}.lock.owner`, JSON.stringify({ ...record, pid: 2 ** 22 + 7, dir: "0:0:0:0" }));
			expect(() => withSessionFileLock(file, () => undefined, 100)).toThrow(/already being held/);
			// The same dead pid on another host proves nothing here either.
			writeFileSync(`${file}.lock.owner`, JSON.stringify({ ...record, pid: 2 ** 22 + 7, host: "elsewhere" }));
			expect(() => withSessionFileLock(file, () => undefined, 100)).toThrow(/already being held/);
		} finally {
			release();
		}
	});

	it("is taken over from a reused pid once the background check sees another start time", async () => {
		const release = lockSessionFile(file);
		const record = JSON.parse(readFileSync(`${file}.lock.owner`, "utf8"));
		// A live pid (the runner's parent) recorded with a start time it does not have.
		writeFileSync(`${file}.lock.owner`, JSON.stringify({ ...record, pid: process.ppid, started: "1" }));
		try {
			// The first try only asks `ps` in the background: the owner counts as alive until it answers.
			expect(() => withSessionFileLock(file, () => undefined, 50)).toThrow(/already being held/);
			await new Promise((done) => setTimeout(done, 1500));
			expect(withSessionFileLock(file, () => "taken", 50)).toBe("taken");
		} finally {
			release();
		}
	}, 10_000);
});
