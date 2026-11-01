import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../../../common/src/atomic-file.ts";
import { saveDecision } from "../../src/octocode/shared/trust.ts";
import { readStore, storeKey, storePath, withFileLock } from "../../src/octocode/shared/trust/store.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-trust-lock-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("trust store lock", () => {
	it("never lets a second writer break a slow writer's lock and lose its decision", () => {
		const home = tempDir();
		const slow = tempDir();
		const other = tempDir();
		const file = storePath(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		let secondError: unknown;
		withFileLock(file, (assertHeld) => {
			const store = readStore(home);
			// The slow writer is still between its read and its write when another session saves a decision.
			try {
				saveDecision(other, "sha-other", false, home);
			} catch (error) {
				secondError = error;
			}
			store[storeKey(slow)] = { sha: "sha-slow", trusted: true };
			assertHeld();
			atomicWriteFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
		});
		// The second writer reports that the store is busy instead of writing a decision the first then drops.
		expect(secondError).toMatchObject({ code: "ELOCKED" });
		expect(readStore(home)).toEqual({ [storeKey(slow)]: { sha: "sha-slow", trusted: true } });
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
		// Once the lock is free the decision saves normally.
		saveDecision(other, "sha-other", false, home);
		expect(readStore(home)[storeKey(other)]).toEqual({ sha: "sha-other", trusted: false });
	});

	it("clears a stale lock file left by an earlier build", () => {
		const home = tempDir();
		const cwd = tempDir();
		const file = storePath(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(`${file}.lock`, "");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(`${file}.lock`, old, old);
		saveDecision(cwd, "sha", true, home);
		expect(readStore(home)[storeKey(cwd)]).toEqual({ sha: "sha", trusted: true });
	});
});
