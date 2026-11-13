import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock, withFileLockSync } from "../src/file-write-lock.ts";
import { guardLockOwner, recordLockOwner } from "../src/lock-owner.ts";

let dir: string;
let file: string;
let lock: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-live-lock-"));
	file = path.join(dir, "store.json");
	lock = `${file}.lock`;
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("recorded lock ownership", () => {
	it("protects a stalled synchronous holder after the library stale timeout", () => {
		withFileLockSync(file, () => {
			// Advancing the clock ages the existing directory without changing its identity (utimes can change birthtime).
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
			expect(() => withFileLockSync(file, () => "stolen", { attempts: 1 })).toThrow(
				expect.objectContaining({ code: "ELOCKED" }),
			);
			expect(fs.existsSync(`${lock}.owner`)).toBe(true);
		});
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("protects an asynchronous holder from synchronous and asynchronous stale takeover", async () => {
		await withFileLock(file, async () => {
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
			expect(() => withFileLockSync(file, () => "stolen", { attempts: 1 })).toThrow(
				expect.objectContaining({ code: "ELOCKED" }),
			);
			await expect(withFileLock(file, async () => "stolen")).rejects.toMatchObject({ code: "ELOCKED" });
		});
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("checks ownership again at stale removal when a record appeared after the precheck", async () => {
		fs.mkdirSync(lock);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		const guard = guardLockOwner(lock);
		guard.check();
		const forget = recordLockOwner(lock);
		try {
			expect(() => guard.fs.rmdirSync(lock)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
			await expect(
				new Promise<void>((resolve, reject) => guard.fs.rmdir(lock, (error) => (error ? reject(error) : resolve()))),
			).rejects.toMatchObject({ code: "ELOCKED" });
			expect(fs.statSync(lock).isDirectory()).toBe(true);
		} finally {
			forget();
		}
	});

	it("keeps a legacy owner's identity through heartbeat changes to ctime", () => {
		fs.mkdirSync(lock);
		const stat = fs.statSync(lock, { bigint: true });
		fs.writeFileSync(
			`${lock}.owner`,
			JSON.stringify({
				pid: process.pid,
				host: os.hostname(),
				dir: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}`,
			}),
		);
		const heartbeat = new Date(Date.now() + 1000);
		fs.utimesSync(lock, heartbeat, heartbeat);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		expect(() => guardLockOwner(lock).check()).toThrow(expect.objectContaining({ code: "ELOCKED" }));
	});

	it("refuses stale removal after a successor replaced the observed directory, even before its owner record", () => {
		fs.mkdirSync(lock);
		const guard = guardLockOwner(lock);
		guard.check();
		fs.renameSync(lock, `${lock}.old`);
		fs.mkdirSync(lock);
		expect(() => guard.fs.rmdirSync(lock)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
		expect(fs.statSync(lock).isDirectory()).toBe(true);
	});

	it("leaves explicit dead-owner removal to the next acquisition check, without a second rmdir", () => {
		fs.mkdirSync(lock);
		const guard = guardLockOwner(lock);
		guard.check();
		const stat = fs.statSync(lock, { bigint: true });
		fs.writeFileSync(
			`${lock}.owner`,
			JSON.stringify({
				pid: process.pid + 30_000,
				host: os.hostname(),
				dir: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
			}),
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		expect(() => guard.fs.rmdirSync(lock)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
		expect(fs.existsSync(lock)).toBe(true);
		guard.check();
		expect(fs.existsSync(lock)).toBe(false);
		fs.mkdirSync(lock);
		const forget = recordLockOwner(lock);
		try {
			expect(() => guard.fs.rmdirSync(lock)).toThrow(expect.objectContaining({ code: "ELOCKED" }));
			expect(fs.statSync(lock).isDirectory()).toBe(true);
		} finally {
			forget();
		}
	});

	it("does not forget a successor's owner record when an older holder releases", () => {
		fs.mkdirSync(lock);
		const forgetOld = recordLockOwner(lock);
		fs.rmdirSync(lock);
		fs.mkdirSync(lock);
		const forgetNew = recordLockOwner(lock);
		const current = fs.readFileSync(`${lock}.owner`, "utf8");
		forgetOld();
		expect(fs.readFileSync(`${lock}.owner`, "utf8")).toBe(current);
		forgetNew();
		expect(fs.existsSync(`${lock}.owner`)).toBe(false);
	});
});
