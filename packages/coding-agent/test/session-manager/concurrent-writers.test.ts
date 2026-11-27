import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileEntry, SessionManager, type SessionEntry } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

// Pin the first ids `generateId` hands out so a test can force two writers to pick the same one.
const forcedIds = vi.hoisted(() => [] as string[]);
vi.mock("crypto", async (importOriginal) => {
	const original = await importOriginal<typeof NodeCrypto>();
	return { ...original, randomUUID: () => forcedIds.shift() ?? original.randomUUID() };
});

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../scripts/source-resolver.ts")).href;
const sessionManagerUrl = pathToFileURL(resolve(__dirname, "../../src/core/session-manager.ts")).href;
const sharedFileUrl = pathToFileURL(resolve(__dirname, "../../src/core/session-manager/shared-file.ts")).href;

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-concurrent-"));
	forcedIds.length = 0;
	const seed = SessionManager.create(dir, dir);
	seed.appendMessage(userMsg("hello"));
	seed.appendMessage(assistantMsg("hi"));
	file = seed.getSessionFile()!;
});
afterEach(async () => {
	await sessionMirrorSettled();
	rmSync(dir, { recursive: true, force: true });
});

const open = () => SessionManager.open(file, dir, dir);
const records = () =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry)
		.filter((e): e is SessionEntry => e.type !== "session");
const customs = () => records().filter((e) => e.type === "custom");

describe("locked session appends", () => {
	it("keeps both writers' entries, each under its own parent", () => {
		const a = open();
		const b = open();
		const base = a.getLeafId();
		const a1 = a.appendCustomEntry("a", 1);
		const b1 = b.appendCustomEntry("b", 1);
		const a2 = a.appendCustomEntry("a", 2);
		const b2 = b.appendCustomEntry("b", 2);

		const byId = new Map(records().map((e) => [e.id, e]));
		expect(byId.get(a1)?.parentId).toBe(base);
		expect(byId.get(b1)?.parentId).toBe(base);
		expect(byId.get(a2)?.parentId).toBe(a1);
		expect(byId.get(b2)?.parentId).toBe(b1);
		expect(new Set(records().map((e) => e.id)).size).toBe(records().length);

		// Each writer indexed the other's entries without moving its own leaf.
		expect(a.getLeafId()).toBe(a2);
		expect(b.getLeafId()).toBe(b2);
		expect(a.getEntry(b1)).toBeDefined();
		expect(b.getEntry(a2)).toBeDefined();

		// A fresh load lists both branches under the shared parent; the leaf is the last line.
		const reopened = open();
		expect(reopened.getLeafId()).toBe(b2);
		expect(
			reopened
				.getChildren(base!)
				.map((e) => e.id)
				.sort(),
		).toEqual([a1, b1].sort());
	});

	it("merges foreign labels and keeps file order in memory", () => {
		const a = open();
		const b = open();
		const target = b.getLeafId()!;
		b.appendLabelChange(target, "mark");
		a.appendCustomEntry("a", 1);
		expect(a.getLabel(target)).toBe("mark");
		expect(a.getEntries().map((e) => e.id)).toEqual(records().map((e) => e.id));
	});

	it("two writers recording the same durable completion keep one entry and the original receipt ID", async () => {
		const first = open();
		const second = open();
		const receipt = { entryId: "wake-42", recorded: vi.fn() };
		for (const session of [first, second]) {
			expect(session.appendCustomMessageEntry("task", "completed", true, undefined, undefined, receipt)).toBe(
				receipt.entryId,
			);
		}
		await Promise.resolve();
		expect(receipt.recorded).toHaveBeenCalledTimes(2);
		const followUp = second.appendCustomEntry("after", {});
		expect(open().getEntry(followUp)?.parentId).toBe(receipt.entryId);
		expect(records().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
		expect(second.getEntries().map((entry) => entry.id)).toEqual(records().map((entry) => entry.id));
	});

	it("acknowledges a receipt already indexed from a different writer without switching branches", async () => {
		const first = open();
		const second = open();
		const receipt = { entryId: "wake-5", recorded: vi.fn() };
		first.appendCustomMessageEntry("task", "done", true, undefined, undefined, receipt);
		const branch = second.appendCustomEntry("different branch", 1);
		second.appendCustomMessageEntry("task", "done", true, undefined, undefined, receipt);
		await Promise.resolve();
		expect(receipt.recorded).toHaveBeenCalledTimes(2);
		expect(second.getLeafId()).toBe(branch);
		expect(records().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("gives a pending entry a fresh id when a foreign entry already uses its id", () => {
		const a = open();
		const b = open();
		forcedIds.push("deadbeef", "deadbeef");
		const foreignId = b.appendCustomEntry("b", 1);
		const ownId = a.appendCustomEntry("a", 1);

		expect(foreignId).toBe("deadbeef");
		expect(ownId).not.toBe("deadbeef");
		const ids = records().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(customs().find((e) => e.id === ownId)?.type).toBe("custom");
		expect(a.getLeafId()).toBe(ownId);
		expect(a.getEntry(ownId)?.id).toBe(ownId);
		expect(a.getEntry("deadbeef")).toMatchObject({ customType: "b" });
	});

	it("repairs a compaction that points at its own colliding id", () => {
		const a = open();
		const b = open();
		forcedIds.push("cafecafe", "cafecafe");
		b.appendCustomEntry("b", 1);
		const id = a.appendCompaction("summary", null, 10);
		const entry = records().find((e) => e.id === id);
		expect(entry).toMatchObject({ type: "compaction", firstKeptEntryId: id });
	});

	it("refuses to write after another process truncated the file, leaving it unchanged", () => {
		const a = open();
		truncateSync(file, statSync(file).size - 7);
		const before = readFileSync(file);
		expect(() => a.appendCustomEntry("a", 1)).toThrow(/Session persistence failed.*shrank/s);
		expect(readFileSync(file).equals(before)).toBe(true);
		expect(a.getEntries().some((e) => e.type === "custom")).toBe(false);
		// The failure is sticky: later writes stay blocked.
		expect(() => a.appendCustomEntry("a", 2)).toThrow(/Session persistence failed/);
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("seals a partial record a stopped process left, and another live writer's merge steps over it", () => {
		const a = open();
		const b = open();
		const foreign = b.appendCustomEntry("b", 1);
		appendFileSync(file, '{"type":"custom","id":"zz');
		const before = readFileSync(file);
		const own = a.appendCustomEntry("a", 1);
		expect(readFileSync(file).subarray(0, before.length).equals(before)).toBe(true);
		// `b` knows nothing past its own record: its merge reads the sealed line and the record that names it.
		const later = b.appendCustomEntry("b", 2);
		const ids = open()
			.getEntries()
			.map((e) => e.id);
		expect(ids.slice(-4)).toEqual([foreign, ids.at(-3), own, later]);
		expect(b.getEntry(ids.at(-3)!)).toMatchObject({ customType: "octocode-session-recovery" });
		expect(a.getEntry(foreign)).toBeDefined();
		expect(b.getEntry(own)).toBeDefined();
		expect(b.getEntries().map((e) => e.id)).toEqual(ids);
	});

	it("refuses a malformed line no record accounts for, even one that was ended with a newline, leaving the file unchanged", () => {
		const a = open();
		appendFileSync(file, '{"type":"custom","id":"zz\n');
		const before = readFileSync(file);
		expect(() => a.appendCustomEntry("a", 1)).toThrow(/Session persistence failed.*malformed/s);
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("refuses a final line that is JSON but not a record, leaving the file unchanged", () => {
		const a = open();
		appendFileSync(file, "123");
		const before = readFileSync(file);
		expect(() => a.appendCustomEntry("a", 1)).toThrow(/Session persistence failed.*incomplete/s);
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("refuses to seal after a malformed foreign record, writing nothing", () => {
		const a = open();
		appendFileSync(file, '{"type":"custom","id":"zz\n{"type":"custom","id":"yy');
		const before = readFileSync(file);
		expect(() => a.appendCustomEntry("a", 1)).toThrow(/Session persistence failed.*malformed/s);
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("rewrite keeps entries another process appended", () => {
		const a = open();
		const b = open();
		const foreignId = b.appendCustomEntry("b", 1);
		(a as unknown as { _rewriteFile(): void })._rewriteFile();
		expect(records().map((e) => e.id)).toContain(foreignId);
		expect(a.getEntry(foreignId)).toBeDefined();
		// The rewrite recorded the new size, so the next append is a plain append.
		const ownId = a.appendCustomEntry("a", 1);
		expect(records().map((e) => e.id)).toEqual(expect.arrayContaining([foreignId, ownId]));
	});

	it("leaves no lock behind and does not touch in-memory sessions", () => {
		const a = open();
		a.appendCustomEntry("a", 1);
		expect(() => statSync(`${file}.lock`)).toThrow();
		const memory = SessionManager.inMemory();
		memory.appendMessage(userMsg("x"));
		expect(memory.getEntries()).toHaveLength(1);
	});

	it("flushes a short-lived process's held last entry before natural exit", async () => {
		const script = join(dir, "held-writer.mts");
		writeFileSync(
			script,
			`import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
import { lockSessionFile } from ${JSON.stringify(sharedFileUrl)};
const [file, dir] = process.argv.slice(2);
const session = SessionManager.open(file, dir, dir);
const release = lockSessionFile(file);
session.appendCustomEntry("last-held", 1);
setTimeout(release, 300).unref();
`,
		);
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, script, file, dir], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		expect(await new Promise((done) => child.once("close", done)), stderr).toBe(0);
		expect(customs().filter((entry) => entry.customType === "last-held")).toHaveLength(1);
	}, 30_000);

	it("keeps two processes' concurrent appends parseable and unlost", async () => {
		const script = join(dir, "child-writer.mts");
		writeFileSync(
			script,
			`import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const [file, dir, count] = process.argv.slice(2);
const session = SessionManager.open(file, dir, dir);
console.log("ready");
for (let n = 0; n < Number(count); n++) {
	session.appendCustomEntry("child", n);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}
`,
		);
		const count = 40;
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, script, file, dir, String(count)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const ready = new Promise<void>((done) => child.stdout.once("data", () => done()));
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		const exited = new Promise<number | null>((done) => child.once("close", done));

		const parent = open();
		const base = parent.getLeafId();
		await ready; // both writers start from the same leaf
		const own: string[] = [];
		for (let n = 0; n < count; n++) {
			own.push(parent.appendCustomEntry("parent", n));
			await new Promise((r) => setTimeout(r, 2));
		}
		expect(await exited, stderr).toBe(0);
		parent.retire(); // A nonblocking last append may still be held; hosts flush before finishing a session.

		const all = records();
		expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
		const byId = new Map(all.map((e) => [e.id, e]));
		const parentEntries = customs().filter((e) => e.type === "custom" && e.customType === "parent");
		const childEntries = customs().filter((e) => e.type === "custom" && e.customType === "child");
		const order = customs().map((e) => (e.type === "custom" ? e.customType : ""));
		expect(order.filter((who, n) => n > 0 && who !== order[n - 1]).length).toBeGreaterThan(3); // really interleaved
		expect(parentEntries).toHaveLength(count);
		expect(childEntries).toHaveLength(count);
		expect(parentEntries.map((e) => e.id)).toEqual(own);
		parentEntries.forEach((e, n) => expect(e.parentId).toBe(n === 0 ? base : own[n - 1]));
		childEntries.forEach((e, n) => expect(e.parentId).toBe(n === 0 ? base : childEntries[n - 1].id));
		expect(childEntries.every((e) => byId.has(e.parentId!))).toBe(true);
		expect(open().getChildren(base!)).toHaveLength(2);
	}, 30_000);
});

describe("review fixes", () => {
	const stateOf = (session: SessionManager) => (session as unknown as { state: { fileSize?: number } }).state;

	it("skips records it already holds when its known size lags the file (S1-1)", () => {
		const a = open();
		const b = open();
		const b1 = b.appendCustomEntry("b", 1);
		const reloaded = open(); // already holds b1
		// Simulate a size taken before b1 was written, ending inside the record before it.
		stateOf(reloaded).fileSize = statSync(file).size - JSON.stringify(b.getEntry(b1)).length - 5;
		const r1 = reloaded.appendCustomEntry("r", 1);
		const ids = records().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(-2)).toEqual([b1, r1]);
		expect(a.appendCustomEntry("a", 1)).toBeDefined();
	});

	it("does not duplicate records re-read after another writer rewrote the file (S1-2)", () => {
		const a = open();
		a.appendCustomEntry("a", 0);
		const b = open();
		const b1 = b.appendCustomEntry("b", 1);
		(b as unknown as { _rewriteFile(): void })._rewriteFile();
		// Simulate a stale size inside a record `a` already holds, as after a rewrite that moved bytes.
		stateOf(a).fileSize = statSync(file).size - JSON.stringify(b.getEntry(b1)).length - 20;
		const a1 = a.appendCustomEntry("a", 1);
		const ids = records().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(-2)).toEqual([b1, a1]);
	});

	it("keeps a record in memory while a lock is held past the wait, and writes it first afterwards (S1-3)", async () => {
		const lockfile = (await import("proper-lockfile")).default;
		const session = open();
		const release = lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.lock` });
		const before = readFileSync(file);
		let held: string;
		try {
			// Not refused and not a permanent failure: the record is part of the session, only its write waits.
			held = session.appendCustomEntry("blocked", 1);
			expect(session.getLeafId()).toBe(held);
			expect(readFileSync(file).equals(before)).toBe(true);
		} finally {
			release();
		}
		const id = session.appendCustomEntry("retried", 1);
		expect(customs().map((e) => e.id)).toEqual([held, id]);
		expect(session.getLeafId()).toBe(id);
	}, 10_000);
});

describe("locked append latency", () => {
	it("stays small per append", () => {
		const session = open();
		const samples: number[] = [];
		for (let n = 0; n < 200; n++) {
			const start = performance.now();
			session.appendCustomEntry("latency", n);
			samples.push(performance.now() - start);
		}
		samples.sort((x, y) => x - y);
		const p95 = samples[Math.floor(samples.length * 0.95)];
		console.info(`locked append latency: p50=${samples[100].toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
		// Loose bound that only catches a pathological lock (the target of a few ms is measured, not asserted).
		expect(p95).toBeLessThan(100);
	});
});
