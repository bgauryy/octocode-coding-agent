import fs, { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTornTail, SessionManager } from "../../src/core/session-manager.ts";

/** A failed write must not wedge a session, and nothing may ever be removed from its file. */

const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });
const toolResult = (id: string) => ({
	role: "toolResult" as const,
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text" as const, text: "done" }],
	isError: false,
	timestamp: 2,
});

describe("after a failed write", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-write-recovery-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		rmSync(dir, { recursive: true, force: true });
	});

	function diskFull(tearAt?: number) {
		const original = fs.appendFileSync;
		const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((target, data) => {
			if (tearAt !== undefined) original(target, String(data).slice(0, tearAt));
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		});
		syncBuiltinESMExports();
		return () => {
			spy.mockRestore();
			syncBuiltinESMExports();
		};
	}

	function started() {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage(user("first"));
		return { manager, root, file: manager.getSessionFile()! };
	}

	it("seals its own torn tail once the disk has room: no byte is removed and the session goes on", () => {
		const { manager, root, file } = started();
		const bytes = readFileSync(file, "utf8");
		const freed = diskFull(40);
		expect(() => manager.appendMessage(toolResult("t1"))).toThrow(/ENOSPC.*next write tries again/s);
		const torn = readFileSync(file, "utf8");
		expect(torn.length).toBe(bytes.length + 40);
		expect(hasTornTail(file)).toBe(true);
		// Still full: the seal itself fails, so the block stays and the file does not change.
		const stillFull = vi.mocked(fs.appendFileSync);
		stillFull.mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		});
		expect(() => manager.appendMessage(user("while full"))).toThrow(/persistence failed/);
		expect(readFileSync(file, "utf8")).toBe(torn);
		freed();

		const next = manager.appendMessage(user("disk freed"));

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(`${torn}\n`)).toBe(true);
		expect(hasTornTail(file)).toBe(false);
		// The record that names the sealed fragment sits between the last whole record and the next one.
		const recovery = manager.getEntry(manager.getEntry(next)!.parentId!);
		expect(recovery).toMatchObject({
			type: "custom",
			customType: "octocode-session-recovery",
			parentId: root,
			data: { offset: bytes.length, bytes: 40 },
		});
		const later = manager.appendMessage(user("and the next"));
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([root, recovery!.id, next, later]);
		expect(readFileSync(file, "utf8").startsWith(after)).toBe(true);
	});

	it("goes on when the failed write left nothing behind", () => {
		const { manager, root, file } = started();
		const bytes = readFileSync(file, "utf8");
		const freed = diskFull();
		expect(() => manager.appendMessage(user("lost"))).toThrow(/ENOSPC/);
		freed();
		expect(readFileSync(file, "utf8")).toBe(bytes);
		const next = manager.appendMessage(user("after"));
		expect(manager.getEntry(next)?.parentId).toBe(root);
		expect(SessionManager.open(file, dir).getEntries()).toHaveLength(2);
	});

	it("seals a torn tail of unknown origin at the next write: every byte stays, and a record names them", () => {
		const { root, file } = started();
		const fragment = '{"type":"message","id":"torn","parentId":null,"timesta';
		appendFileSync(file, fragment);
		const bytes = readFileSync(file);
		const reopened = SessionManager.open(file, dir);
		expect(hasTornTail(file)).toBe(true);

		const next = reopened.appendMessage(user("after the crash"));

		const after = readFileSync(file);
		expect(after.subarray(0, bytes.length).equals(bytes)).toBe(true);
		expect(after.toString("utf8", bytes.length, bytes.length + 1)).toBe("\n");
		expect(hasTornTail(file)).toBe(false);
		const recovery = reopened.getEntry(reopened.getEntry(next)!.parentId!);
		expect(recovery).toMatchObject({
			customType: "octocode-session-recovery",
			parentId: root,
			data: { offset: bytes.length - fragment.length, bytes: fragment.length },
		});
		const again = SessionManager.open(file, dir);
		expect(again.getEntries().map((entry) => entry.id)).toEqual([root, recovery!.id, next]);
		expect(
			again.buildSessionContext().messages.map((message) => ("content" in message ? message.content : "")),
		).toEqual(["first", "after the crash"]);
	});

	it("seals a fragment another writer left after its own failure that wrote nothing, without taking it for its own", () => {
		const { manager, root, file } = started();
		const freed = diskFull();
		expect(() => manager.appendMessage(user("second"))).toThrow(/ENOSPC/);
		freed();
		// Every message record starts like this, so the bytes alone would pass for this process's own.
		appendFileSync(file, '{"type":"message","id":"');
		const before = readFileSync(file);
		const third = manager.appendMessage(user("third"));
		expect(readFileSync(file).subarray(0, before.length).equals(before)).toBe(true);
		const reopened = SessionManager.open(file, dir);
		const ids = reopened.getEntries().map((entry) => entry.id);
		expect(ids).toHaveLength(3);
		expect(ids[0]).toBe(root);
		expect(ids[2]).toBe(third);
		expect(reopened.getEntry(ids[1])).toMatchObject({ customType: "octocode-session-recovery", parentId: root });
		expect(
			reopened.buildSessionContext().messages.map((message) => ("content" in message ? message.content : "")),
		).toEqual(["first", "third"]);
	});

	it("a sealed fragment does not stop a later reader or a fork", () => {
		const { manager, file } = started();
		const freed = diskFull(25);
		expect(() => manager.appendMessage(user("torn"))).toThrow(/ENOSPC/);
		freed();
		manager.appendMessage(user("after"));
		const fork = SessionManager.forkFrom(file, dir, join(dir, "forks"));
		expect(fork.buildSessionContext().messages).toHaveLength(2);
		const reader = SessionManager.open(file, dir);
		expect(reader.appendMessage(user("from a new process"))).toBeTruthy();
	});
});

describe("a lock another process holds past the wait", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-held-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function held<T>(file: string, work: () => T): T {
		const release = lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.lock` });
		try {
			return work();
		} finally {
			release();
		}
	}

	it("keeps a tool result in memory, in order, and saves it first at the next write", () => {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage(user("first"));
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file);
		const kept = held(file, () => manager.appendMessage(toolResult("t1")));

		expect(readFileSync(file).equals(bytes)).toBe(true);
		expect(manager.getLeafId()).toBe(kept);
		expect(manager.getEntry(kept)?.parentId).toBe(root);
		expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "toolResult"]);

		const next = manager.appendMessage(user("next"));

		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([root, kept, next]);
		expect(reopened.getEntry(next)?.parentId).toBe(kept);
		const size = statSync(file).size;
		manager.appendMessage(user("once only"));
		expect(readFileSync(file, "utf8").slice(size).split("\n")).toHaveLength(2);
	}, 10_000);

	it("keeps two in a row and merges a foreign record before them", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		const file = manager.getSessionFile()!;
		const other = SessionManager.open(file, dir);
		const one = held(file, () => manager.appendMessage(toolResult("t1")));
		const two = held(file, () => manager.appendMessage(toolResult("t2")));
		const foreign = other.appendCustomEntry("foreign", 1);
		const next = manager.appendCustomEntry("mine", 1);
		const ids = SessionManager.open(file, dir)
			.getEntries()
			.map((entry) => entry.id);
		expect(ids.slice(-4)).toEqual([foreign, one, two, next]);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual(ids);
	}, 20_000);

	it("saves held entries when the manager is retired, and a later write does not repeat them", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		const file = manager.getSessionFile()!;
		const kept = held(file, () => manager.appendMessage(toolResult("t1")));
		manager.retire();
		expect(SessionManager.open(file, dir).getEntry(kept)).toBeDefined();
		manager.appendCustomEntry("after", 1);
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().filter((entry) => entry.id === kept)).toHaveLength(1);
	}, 10_000);

	it("keeps a user message too, instead of refusing it after seconds of waiting", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("first"));
		const file = manager.getSessionFile()!;
		const again = held(file, () => manager.appendMessage(user("again")));
		expect(manager.getLeafId()).toBe(again);
		// Written first by the next record once the lock is free.
		manager.appendMessage(user("after"));
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().filter((entry) => entry.id === again)).toHaveLength(1);
	}, 10_000);
});
