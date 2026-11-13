import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileUnlocked } from "../src/atomic-file.ts";
import { withFileLock, withFileLockSync } from "../src/file-write-lock.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-lock-async-"));
	dirs.push(dir);
	return path.join(dir, "view.txt");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
	it("takes the same lock as withFileLockSync: each holder makes the other fail with ELOCKED at once", async () => {
		const file = tempFile();
		await withFileLock(file, async () => {
			expect(() => withFileLockSync(file, () => "second", { attempts: 1 })).toThrow(
				expect.objectContaining({ code: "ELOCKED" }),
			);
		});
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
		// Another process inside its synchronous hold: the lock directory exists.
		fs.mkdirSync(`${file}.lock`);
		await expect(withFileLock(file, async () => "second")).rejects.toMatchObject({ code: "ELOCKED" });
		fs.rmdirSync(`${file}.lock`);
		expect(await withFileLock(file, async () => "free")).toBe("free");
	});

	it("reports a takeover through assertHeld, writes nothing, and leaves the successor's lock in place", async () => {
		const file = tempFile();
		fs.writeFileSync(file, "old");
		const lock = `${file}.lock`;
		await expect(
			withFileLock(file, async (assertHeld) => {
				await assertHeld();
				// Another process judged this holder stale and took over: a new lock directory.
				fs.rmdirSync(lock);
				fs.mkdirSync(lock);
				await atomicWriteFileUnlocked(file, "new", { beforeCommit: assertHeld });
			}),
		).rejects.toMatchObject({ code: "ECOMPROMISED" });
		expect(fs.readFileSync(file, "utf8")).toBe("old");
		expect(fs.existsSync(lock)).toBe(true);
		expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["view.txt", "view.txt.lock"]);
	});

	it("releases the lock when the update throws", async () => {
		const file = tempFile();
		await expect(
			withFileLock(file, async () => {
				throw new Error("update failed");
			}),
		).rejects.toThrow("update failed");
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});
});

describe("atomicWriteFileUnlocked", () => {
	it("replaces the file whole, keeping the requested mode, and writes nothing when beforeCommit throws", async () => {
		const file = tempFile();
		await atomicWriteFileUnlocked(file, "first\n", { mode: 0o600 });
		expect(fs.readFileSync(file, "utf8")).toBe("first\n");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await expect(
			atomicWriteFileUnlocked(file, "second\n", {
				beforeCommit: async () => {
					throw new Error("refused");
				},
			}),
		).rejects.toThrow("refused");
		expect(fs.readFileSync(file, "utf8")).toBe("first\n");
		expect(fs.readdirSync(path.dirname(file))).toEqual(["view.txt"]);
	});
});
