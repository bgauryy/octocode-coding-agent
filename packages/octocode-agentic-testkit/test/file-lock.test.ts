import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/file-lock.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const lockPath = (): string => {
	const d = mkdtempSync(join(tmpdir(), "testkit-lock-"));
	dirs.push(d);
	return join(d, "file.json.lock");
};
const backdate = (path: string, ms: number): void => {
	const t = new Date(Date.now() - ms);
	utimesSync(path, t, t);
};

describe("withFileLock", () => {
	it("runs the function holding the lock and releases it, also when the function throws", () => {
		const lock = lockPath();
		expect(withFileLock(lock, () => existsSync(lock))).toBe(true);
		expect(existsSync(lock)).toBe(false);
		expect(() =>
			withFileLock(lock, () => {
				throw new Error("inside");
			}),
		).toThrow("inside");
		expect(existsSync(lock)).toBe(false);
	});

	it("breaks a lock older than staleMs, which a holder that died left behind", () => {
		const lock = lockPath();
		mkdirSync(lock);
		backdate(lock, 5_000);
		const t0 = Date.now();
		expect(withFileLock(lock, () => "ran", { staleMs: 1_000, timeoutMs: 3_000 })).toBe("ran");
		expect(Date.now() - t0).toBeLessThan(1_000);
	});

	it("also breaks a stale breaker guard, so a breaker that died does not block the lock forever", () => {
		const lock = lockPath();
		mkdirSync(lock);
		mkdirSync(`${lock}.break`);
		backdate(lock, 5_000);
		backdate(`${lock}.break`, 5_000);
		expect(withFileLock(lock, () => "ran", { staleMs: 1_000, timeoutMs: 3_000 })).toBe("ran");
		expect(existsSync(`${lock}.break`)).toBe(false);
	});

	it("must fail: a fresh lock is never broken; the wait times out naming the lock, without running the function", () => {
		const lock = lockPath();
		mkdirSync(lock);
		let ran = false;
		const t0 = Date.now();
		expect(() =>
			withFileLock(
				lock,
				() => {
					ran = true;
				},
				{ staleMs: 60_000, timeoutMs: 150 },
			),
		).toThrow(`lock ${lock} is still held after 150 ms`);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
		expect(ran).toBe(false);
		expect(existsSync(lock)).toBe(true);
	});

	it("must fail: a lock that cannot be created throws at once instead of waiting", () => {
		const lock = join(lockPath(), "missing-parent", "file.lock");
		const t0 = Date.now();
		expect(() => withFileLock(lock, () => 1, { timeoutMs: 5_000 })).toThrow(`cannot create lock ${lock}`);
		expect(Date.now() - t0).toBeLessThan(1_000);
	});
});
