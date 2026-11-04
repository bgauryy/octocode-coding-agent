import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("session storage boundaries", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-storage-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps the original write destination after an invalid session switch", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const originalFile = manager.getSessionFile()!;
		const invalidFile = join(dir, "invalid.jsonl");
		const invalid = '{"type":"other"}\n';
		writeFileSync(invalidFile, invalid);
		expect(() => manager.setSessionFile(invalidFile)).toThrow("not a valid");
		expect(manager.getSessionFile()).toBe(originalFile);
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		expect(readFileSync(invalidFile, "utf8")).toBe(invalid);
		expect(SessionManager.open(originalFile).buildSessionContext().messages).toHaveLength(2);
	});

	it("migrates legacy history before assigning a current-version fork header", () => {
		const source = join(dir, "legacy.jsonl");
		const original = `${[
			{ type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd: dir },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "first", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: { role: "user", content: "second", timestamp: 2 },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(source, original);
		const fork = SessionManager.forkFrom(source, dir, dir);
		expect(
			fork.buildSessionContext().messages.map((message) => ("content" in message ? message.content : undefined)),
		).toEqual(["first", "second"]);
		expect(fork.getBranch()).toHaveLength(2);
		expect(fork.getHeader()?.version).toBe(3);
		expect(readFileSync(source, "utf8")).toBe(original);
		expect(SessionManager.open(fork.getSessionFile()!).getBranch()).toHaveLength(2);
	});
	it("keeps the exact original bytes, malformed lines included, when a legacy migration rewrites the file", () => {
		const file = join(dir, "legacy-malformed.jsonl");
		const original = [
			JSON.stringify({ type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd: dir }),
			JSON.stringify({ type: "message", timestamp: "t1", message: { role: "user", content: "first", timestamp: 1 } }),
			'{"type":"message","message":{"role":"user","content":"hand-edited',
			JSON.stringify({ type: "message", timestamp: "t2", message: { role: "user", content: "second", timestamp: 2 } }),
			"",
		].join("\n");
		writeFileSync(file, original);
		const manager = SessionManager.open(file, dir);
		expect(manager.getHeader()?.version).toBe(3);
		expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
		manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
		expect(SessionManager.open(file, dir).buildSessionContext().messages).toHaveLength(3);
		expect(fs.existsSync(`${file}.1.bak`)).toBe(false);
	});

	it("leaves no partial fork when copying the source fails midway", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "poison", timestamp: 2 });
		const target = join(dir, "forks");
		const stringify = JSON.stringify;
		const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
			if ((value as { message?: { content?: unknown } } | null)?.message?.content === "poison")
				throw new Error("serialize failure");
			return stringify(value, ...(rest as [never]));
		});
		try {
			expect(() => SessionManager.forkFrom(manager.getSessionFile()!, dir, target)).toThrow("serialize failure");
		} finally {
			spy.mockRestore();
		}
		expect(fs.readdirSync(target)).toEqual([]);
	});

	it("keeps a resumable transcript when replacing a session file fails", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "keep this", timestamp: 1 });
		const file = manager.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw new Error("disk failure");
		});
		try {
			expect(() => (manager as unknown as { _rewriteFile(): void })._rewriteFile()).toThrow("disk failure");
		} finally {
			rename.mockRestore();
		}
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(SessionManager.open(file).buildSessionContext().messages).toHaveLength(1);
		expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("resumes a persisted compaction without deleting the original messages", () => {
		const manager = SessionManager.create(dir, dir);
		const old = manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		const recent = manager.appendMessage({ role: "user", content: "current request", timestamp: 2 });
		manager.appendCompaction("checkpoint", recent, 10000);
		const resumed = SessionManager.open(manager.getSessionFile()!);
		expect(resumed.getEntry(old)).toBeDefined();
		expect(resumed.buildSessionContext().messages).toEqual(manager.buildSessionContext().messages);
		expect(resumed.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
	it("rolls back a failed compaction append to the previous branched leaf", () => {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
		manager.branch(root);
		const before = manager.getEntries();
		const context = manager.buildSessionContext();
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file, "utf8");
		const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
			throw new Error("append failure");
		});
		syncBuiltinESMExports();
		try {
			expect(() => manager.appendCompaction("new boundary", root, 1000)).toThrow("append failure");
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		expect(manager.getLeafId()).toBe(root);
		expect(manager.getEntries()).toEqual(before);
		expect(manager.buildSessionContext()).toEqual(context);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		// Nothing reached the file, so the next write that can succeed goes on from the restored leaf.
		const retried = manager.appendMessage({ role: "user", content: "retry", timestamp: 3 });
		expect(manager.getEntry(retried)?.parentId).toBe(root);
		expect(readFileSync(file, "utf8").startsWith(bytes)).toBe(true);
	});
	it("keeps the leaf where it was when a branch summary cannot be saved", () => {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const leaf = manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
		const before = manager.getEntries();
		const context = manager.buildSessionContext();
		const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
			throw new Error("append failure");
		});
		syncBuiltinESMExports();
		try {
			expect(() => manager.branchWithSummary(root, "left the other branch")).toThrow("append failure");
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toEqual(before);
		expect(manager.buildSessionContext()).toEqual(context);
	});
	it("refuses legacy migration when it would overwrite an incomplete final record", () => {
		const file = join(dir, "legacy-partial.jsonl");
		const bytes =
			JSON.stringify({ type: "session", version: 1, id: "legacy", timestamp: new Date(0).toISOString(), cwd: dir }) +
			"\n" +
			JSON.stringify({
				type: "message",
				timestamp: new Date(1).toISOString(),
				message: { role: "user", content: "original", timestamp: 1 },
			}) +
			"\n" +
			'{"type":"message","message":{"role":"user","content":"partial';
		writeFileSync(file, bytes);
		expect(() => SessionManager.open(file)).toThrow(/incomplete|recover/);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		const manager = SessionManager.create(dir, dir);
		const leaf = manager.appendMessage({ role: "user", content: "active session", timestamp: 1 });
		const originalFile = manager.getSessionFile();
		expect(() => manager.setSessionFile(file)).toThrow(/incomplete|recover/);
		expect(manager.getSessionFile()).toBe(originalFile);
		expect(manager.getLeafId()).toBe(leaf);
		manager.appendMessage({ role: "user", content: "still active", timestamp: 2 });
		expect(readFileSync(file, "utf8")).toBe(bytes);
	});
	it.each(["partial", "complete"])("keeps every byte of an uncertain %s append and goes on after it", (mode) => {
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage({ role: "user", content: "keep original", timestamp: 1 });
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file, "utf8");
		const originalAppend = fs.appendFileSync;
		const append = vi.spyOn(fs, "appendFileSync").mockImplementation((target, data) => {
			const text = String(data);
			originalAppend(target, mode === "partial" ? text.slice(0, 30) : text);
			throw new Error("flush failure");
		});
		syncBuiltinESMExports();
		try {
			expect(() => manager.appendCompaction("not committed", root, 1000)).toThrow("flush failure");
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		const uncertain = readFileSync(file, "utf8");
		expect(uncertain.startsWith(bytes)).toBe(true);
		expect(uncertain.length).toBeGreaterThan(bytes.length);
		expect(manager.getLeafId()).toBe(root);
		// The failed entry is not written again: what reached the file stays, and the next write follows it.
		const next = manager.appendMessage({ role: "user", content: "next write", timestamp: 2 });
		const after = readFileSync(file, "utf8");
		expect(after.startsWith(uncertain)).toBe(true);
		expect(manager.getEntry(next)?.parentId).toBe(root);
		const reopened = SessionManager.open(file);
		expect(reopened.getLeafId()).toBe(next);
		// A whole record that landed is kept, as a branch of its own; a fragment is a malformed line the loader skips.
		expect(reopened.getEntries().some((entry) => entry.type === "compaction")).toBe(mode === "complete");
		expect(after).toContain(mode === "partial" ? `${uncertain.slice(bytes.length)}\n` : uncertain.slice(bytes.length));
	});
});
