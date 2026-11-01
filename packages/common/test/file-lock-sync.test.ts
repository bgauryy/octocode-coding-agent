import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLockSync } from "../src/file-write-lock.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-lock-sync-"));
	dirs.push(dir);
	return path.join(dir, "store.json");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("withFileLockSync", () => {
	it("makes a second writer wait and fail instead of breaking a live holder's lock", () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		const order: string[] = [];
		withFileLockSync(
			file,
			(assertHeld) => {
				// A slow holder: a second writer arrives while it is still inside its read-modify-write.
				expect(() => withFileLockSync(file, () => order.push("second"), { lockfilePath: lock, attempts: 5 })).toThrow(
					expect.objectContaining({ code: "ELOCKED" }),
				);
				assertHeld();
				order.push("first");
			},
			{ lockfilePath: lock },
		);
		expect(order).toEqual(["first"]);
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("stops a holder whose lock was taken over, and leaves the successor's lock in place", () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		let wrote = false;
		expect(() =>
			withFileLockSync(
				file,
				(assertHeld) => {
					// Another process found the lock stale (this holder was stalled) and took it: a new lock directory.
					fs.rmdirSync(lock);
					fs.mkdirSync(lock);
					const old = new Date(Date.now() + 5_000);
					fs.utimesSync(lock, old, old);
					assertHeld();
					wrote = true;
				},
				{ lockfilePath: lock },
			),
		).toThrow(expect.objectContaining({ code: "ECOMPROMISED" }));
		expect(wrote).toBe(false);
		expect(fs.statSync(lock).isDirectory()).toBe(true);
	});

	it("takes over a lock left by a crashed holder once it is stale", () => {
		const file = tempFile();
		const lock = `${file}.lock`;
		fs.mkdirSync(lock);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		expect(withFileLockSync(file, () => "ok", { lockfilePath: lock })).toBe("ok");
		expect(fs.existsSync(lock)).toBe(false);
	});
});
