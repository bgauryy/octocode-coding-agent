import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as NodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ fsync: 0, fsyncSync: 0 }));
vi.mock("node:fs", async (load) => {
	const actual = await load<typeof NodeFs>();
	return {
		...actual,
		fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
			calls.fsync += 1;
			actual.fsync(fd, done);
		},
		fsyncSync: (fd: number) => {
			calls.fsyncSync += 1;
			actual.fsyncSync(fd);
		},
	};
});

const { scheduleSessionSync, syncPendingSessions } = await import("../../src/core/session-manager/deferred-sync.ts");

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-sync-"));
	file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, "{}\n");
	calls.fsync = 0;
	calls.fsyncSync = 0;
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
});
