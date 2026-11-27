import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processStartAsync } from "../src/process-start.ts";
import { breakDeadLockSync } from "../src/lock-owner.ts";

vi.mock("../src/process-start.ts", () => ({ processStartAsync: vi.fn() }));

let dir: string | undefined;
beforeEach(() => {
	vi.mocked(processStartAsync).mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function recordedLock(pid: number): string {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owner-verdict-"));
	const lock = path.join(dir, "file.lock");
	fs.mkdirSync(lock);
	const stat = fs.statSync(lock, { bigint: true });
	fs.writeFileSync(
		`${lock}.owner`,
		JSON.stringify({ pid, host: os.hostname(), started: "1", dir: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }),
	);
	return lock;
}

it("rechecks a cached live owner that later becomes a zombie", async () => {
	const lock = recordedLock(process.pid + 20_000);
	vi.spyOn(process, "kill").mockReturnValue(true);
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	vi.mocked(processStartAsync)
		.mockResolvedValueOnce({ started: "1", zombie: false })
		.mockResolvedValueOnce({ started: "1", zombie: true });
	expect(breakDeadLockSync(lock)).toBe(false);
	await Promise.resolve();
	expect(breakDeadLockSync(lock)).toBe(false);
	clock.mockReturnValue(1001);
	expect(breakDeadLockSync(lock)).toBe(false);
	await Promise.resolve();
	expect(breakDeadLockSync(lock)).toBe(true);
	expect(fs.existsSync(lock)).toBe(false);
});

it("briefly caches an unreadable process so repeated lock retries do not launch repeated ps commands", async () => {
	const lock = recordedLock(process.pid + 20_001);
	vi.spyOn(process, "kill").mockReturnValue(true);
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	vi.mocked(processStartAsync).mockReset().mockResolvedValue(undefined);
	for (let retry = 0; retry < 10; retry++) {
		expect(breakDeadLockSync(lock)).toBe(false);
		await Promise.resolve();
	}
	expect(processStartAsync).toHaveBeenCalledTimes(1);
	clock.mockReturnValue(1001);
	expect(breakDeadLockSync(lock)).toBe(false);
	expect(processStartAsync).toHaveBeenCalledTimes(2);
	await Promise.resolve();
});

it("does not restore evicted process verdicts when their background reads finish", async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owner-cache-"));
	vi.spyOn(process, "kill").mockReturnValue(true);
	const reads: Array<(value: { started: string; zombie: boolean }) => void> = [];
	vi.mocked(processStartAsync).mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
	const locks = Array.from({ length: 66 }, (_, index) => {
		const lock = path.join(dir!, `file-${index}.lock`);
		fs.mkdirSync(lock);
		const stat = fs.statSync(lock, { bigint: true });
		fs.writeFileSync(
			`${lock}.owner`,
			JSON.stringify({
				pid: process.pid + index + 1,
				host: os.hostname(),
				started: "1",
				dir: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}`,
			}),
		);
		return lock;
	});
	for (const lock of locks) expect(breakDeadLockSync(lock)).toBe(false);
	expect(processStartAsync).toHaveBeenCalledTimes(66);
	for (const resolve of reads) resolve({ started: "1", zombie: false });
	await Promise.resolve();
	// The first two entries were evicted before their reads completed. They must be read again.
	for (const lock of locks.slice(0, 2)) expect(breakDeadLockSync(lock)).toBe(false);
	expect(processStartAsync).toHaveBeenCalledTimes(68);
	for (const resolve of reads.slice(66)) resolve({ started: "1", zombie: false });
	await Promise.resolve();
});
