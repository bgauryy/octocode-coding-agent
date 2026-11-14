import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ATTACH_PROTOCOL_VERSION,
	DAEMON_PROTOCOL_VERSION,
	type AttachRecord,
	type DaemonRecord,
} from "@octocodeai/octocode-contracts/daemon";
import {
	readDaemonRecord,
	writeDaemonRecord,
	readAttachRecord,
	writeAttachRecord,
	sweepAttachRecords,
} from "../../src/octocode/web-daemon/records.ts";

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
	it("keeps a replacement attach record written while the old owner's process check yields", async () => {
		const file = path.join(root, "session.json");
		const stale: AttachRecord = {
			protocolVersion: ATTACH_PROTOCOL_VERSION,
			sessionId: "session",
			pid: 2147483647,
			port: 4100,
			token: "stale-token",
			cwd: root,
			repo: { key: root, name: "test", root },
			startedAt: 1,
		};
		writeAttachRecord(file, stale);
		const sweep = sweepAttachRecords(root);
		const replacement = { ...stale, pid: process.pid, token: "replacement-token" };
		writeAttachRecord(file, replacement);
		expect(await sweep).toBe(0);
		expect(readAttachRecord(file)).toEqual(replacement);
	});
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
