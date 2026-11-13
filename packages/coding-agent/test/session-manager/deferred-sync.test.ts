import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as NodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	fsync: 0,
	fsyncSync: 0,
	openError: undefined as string | undefined,
	syncError: undefined as string | undefined,
	closeError: undefined as string | undefined,
}));
vi.mock("node:fs", async (load) => {
	const actual = await load<typeof NodeFs>();
	return {
		...actual,
		open: (file: NodeFs.PathLike, flags: string, done: (error: NodeJS.ErrnoException | null, fd: number) => void) => {
			if (calls.openError) return done(Object.assign(new Error("open failed"), { code: calls.openError }), -1);
			actual.open(file, flags, done);
		},
		fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
			calls.fsync += 1;
			if (calls.syncError) return done(Object.assign(new Error("sync failed"), { code: calls.syncError }));
			actual.fsync(fd, done);
		},
		close: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
			actual.close(fd, (error) => {
				done(calls.closeError ? Object.assign(new Error("close failed"), { code: calls.closeError }) : error);
			});
		},
		fsyncSync: (fd: number) => {
			calls.fsyncSync += 1;
			actual.fsyncSync(fd);
		},
	};
});

const { scheduleSessionSync, sessionSyncFailed, syncPendingSessions } =
	await import("../../src/core/session-manager/deferred-sync.ts");

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-sync-"));
	file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, "{}\n");
	calls.fsync = 0;
	calls.fsyncSync = 0;
	calls.openError = undefined;
	calls.syncError = undefined;
	calls.closeError = undefined;
});
afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Let a sync started by a timer finish its open, fsync and close on the thread pool. */
const settle = async () => {
	vi.useRealTimers();
	await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("deferred session sync", () => {
	it("syncs once appends pause, not while they keep coming", async () => {
		vi.useFakeTimers();
		for (let n = 0; n < 4; n++) {
			scheduleSessionSync(file);
			vi.advanceTimersByTime(100);
		}
		expect(calls.fsync).toBe(0);
		vi.advanceTimersByTime(250);
		await settle();
		expect(calls.fsync).toBe(1);
	});

	it("syncs within the longest delay while appends never pause", async () => {
		vi.useFakeTimers();
		for (let n = 0; n < 12; n++) {
			scheduleSessionSync(file);
			vi.advanceTimersByTime(100);
		}
		await settle();
		expect(calls.fsync).toBe(1);
	});

	it("syncs what is still waiting at once when the process exits", () => {
		scheduleSessionSync(file);
		syncPendingSessions();
		expect(calls.fsyncSync).toBe(1);
		syncPendingSessions();
		expect(calls.fsyncSync).toBe(1);
		expect(process.listeners("exit")).toContain(syncPendingSessions);
	});

	it.each(["EACCES", "EMFILE", "EIO"])("remembers an open failure (%s) and retries it on exit", async (code) => {
		vi.useFakeTimers();
		calls.openError = code;
		scheduleSessionSync(file);
		vi.advanceTimersByTime(250);
		expect(sessionSyncFailed(file)).toBe(true);
		expect(calls.fsync).toBe(0);
		await settle();
		calls.openError = undefined;
		syncPendingSessions();
		expect(calls.fsyncSync).toBe(1);
		expect(sessionSyncFailed(file)).toBe(false);
	});

	it.each(["syncError", "closeError"] as const)(
		"retries a failed %s even after the async operation ends",
		async (failure) => {
			vi.useFakeTimers();
			calls[failure] = "EIO";
			scheduleSessionSync(file);
			vi.advanceTimersByTime(250);
			await settle();
			expect(sessionSyncFailed(file)).toBe(true);
			calls[failure] = undefined;
			syncPendingSessions();
			expect(calls.fsyncSync).toBe(1);
			expect(sessionSyncFailed(file)).toBe(false);
		},
	);

	it("forgets a failed sync once its file is removed", async () => {
		vi.useFakeTimers();
		calls.openError = "EIO";
		scheduleSessionSync(file);
		vi.advanceTimersByTime(250);
		expect(sessionSyncFailed(file)).toBe(true);
		await settle();
		fs.unlinkSync(file);
		syncPendingSessions();
		expect(sessionSyncFailed(file)).toBe(false);
	});
});
