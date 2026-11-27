import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCrashLog, recordCrash, takeUnnotifiedCrash } from "../src/core/crash-log.ts";

describe("crash log persistence", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crash-log-"));
		file = join(dir, "agent", "crashes.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reports an unreadable log instead of an empty history, and keeps it aside on the next write", () => {
		recordCrash({ kind: "fatal_error", error: new Error("first"), cwd: dir }, file);
		writeFileSync(file, '[{"timestamp": "2026-10-31T00:00:00.000Z", "mess'); // a torn write

		const records = readCrashLog(file);
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toMatch(/could not be read/);
		expect(takeUnnotifiedCrash(file)).toBeUndefined();

		expect(recordCrash({ kind: "uncaught_exception", error: new Error("second"), cwd: dir }, file)).toBeDefined();
		expect(readFileSync(`${file}.corrupt`, "utf8")).toContain('"mess');
		expect(readCrashLog(file).map((record) => record.message)).toEqual(["second"]);
	});

	it.skipIf(process.platform === "win32")("writes valid JSON owner-only and keeps every writer's record", () => {
		for (let index = 0; index < 3; index++) {
			recordCrash({ kind: "fatal_error", error: new Error(`crash ${index}`), cwd: dir }, file);
		}
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).map((record: { message: string }) => record.message)).toEqual([
			"crash 0",
			"crash 1",
			"crash 2",
		]);
	});

	it("does not write while another process holds the log's lock", () => {
		recordCrash({ kind: "fatal_error", error: new Error("kept"), cwd: dir }, file);
		const before = readFileSync(file, "utf8");
		const release = lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.lock` });
		try {
			expect(recordCrash({ kind: "fatal_error", error: new Error("racing"), cwd: dir }, file)).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(before);
		} finally {
			release();
		}
		expect(existsSync(`${file}.lock`)).toBe(false);
		recordCrash({ kind: "fatal_error", error: new Error("after"), cwd: dir }, file);
		expect(readCrashLog(file).map((record) => record.message)).toEqual(["kept", "after"]);
	});
});
