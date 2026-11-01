import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "@octocodeai/octocode-contracts/daemon";
import { readDaemonRecord, writeDaemonRecord } from "../../src/octocode/web-daemon/records.ts";

const record = (port: number): DaemonRecord => ({
	pid: process.pid,
	port,
	url: `http://127.0.0.1:${port}/#access=token`,
	protocolVersion: DAEMON_PROTOCOL_VERSION,
	build: "test",
	startedAt: 1,
	nonce: "nonce",
});

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-records-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("daemon records are written atomically and privately", () => {
	it("replaces a record owner-only in a private directory and reads it back", () => {
		const file = path.join(root, "run", "daemon.json");
		writeDaemonRecord(file, record(4100));
		writeDaemonRecord(file, record(4101));
		expect(readDaemonRecord(file)?.port).toBe(4101);
		if (process.platform !== "win32") {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		}
		expect(fs.readdirSync(path.dirname(file))).toEqual(["daemon.json"]);
	});

	it("leaves no temporary file behind when the replacing rename fails", () => {
		const file = path.join(root, "daemon.json");
		// A non-empty directory at the record path makes the rename fail on every platform.
		fs.mkdirSync(path.join(file, "occupied"), { recursive: true });
		expect(() => writeDaemonRecord(file, record(4102))).toThrow();
		expect(fs.readdirSync(root)).toEqual(["daemon.json"]);
	});
});
