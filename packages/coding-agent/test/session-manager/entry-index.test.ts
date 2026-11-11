import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathFromRoot } from "../../src/core/session-manager/ancestors.ts";
import {
	scheduleSessionSync,
	sessionSyncFailed,
	sessionSyncRecovered,
} from "../../src/core/session-manager/deferred-sync.ts";
import { branchPath, EntryIndex } from "../../src/core/session-manager/entry-index.ts";
import type { SessionEntry } from "../../src/core/session-manager/types.ts";

const entry = (id: string, parentId: string | null, text = id) =>
	({ type: "custom", id, parentId, timestamp: "t", customType: "probe", data: text }) as unknown as SessionEntry;
const ids = (path: SessionEntry[]) => path.map((each) => each.id);
const walked = (index: Map<string, SessionEntry>, leaf: SessionEntry | undefined) =>
	pathFromRoot(leaf, (id) => index.get(id));

describe("branchPath", () => {
	it("returns the walked path, extends it by an appended child and gives each caller its own array", () => {
		const index = new EntryIndex();
		const a = entry("a", null);
		const b = entry("b", "a");
		index.set("a", a).set("b", b);
		const first = branchPath(index, b);
		expect(ids(first)).toEqual(["a", "b"]);
		first.pop();
		expect(ids(branchPath(index, b))).toEqual(["a", "b"]);
		const c = entry("c", "b");
		index.set("c", c);
		expect(branchPath(index, c)).toEqual(walked(index, c));
		// Another branch, then back: neither is the kept tail's child.
		const d = entry("d", "a");
		index.set("d", d);
		expect(ids(branchPath(index, d))).toEqual(["a", "d"]);
		expect(ids(branchPath(index, c))).toEqual(["a", "b", "c"]);
		expect(branchPath(index, undefined)).toEqual([]);
	});

	it("walks again after an entry is replaced, removed or the index is rebuilt", () => {
		const index = new EntryIndex();
		const a = entry("a", null);
		const b = entry("b", "a");
		index.set("a", a).set("b", b);
		branchPath(index, b);
		const replaced = entry("a", null, "new");
		index.set("a", replaced);
		expect(branchPath(index, b)[0]).toBe(replaced);
		index.delete("a");
		expect(ids(branchPath(index, b))).toEqual(["b"]);
		index.clear();
		index.set("a", a).set("b", b);
		expect(ids(branchPath(index, b))).toEqual(["a", "b"]);
		// Setting the same entry again is not a rewrite.
		const before = index.rewrites;
		index.set("b", b);
		expect(index.rewrites).toBe(before);
	});

	it("does not extend the kept path with an entry the index does not hold", () => {
		const index = new EntryIndex();
		const a = entry("a", null);
		index.set("a", a);
		branchPath(index, a);
		const stray = entry("x", "a");
		expect(branchPath(index, stray)).toEqual(walked(index, stray));
		expect(ids(branchPath(index, a))).toEqual(["a"]);
	});

	it("walks a plain map without keeping anything", () => {
		const plain = new Map<string, SessionEntry>();
		const a = entry("a", null);
		const b = entry("b", "a");
		plain.set("a", a).set("b", b);
		expect(ids(branchPath(plain, b))).toEqual(["a", "b"]);
	});
});

describe("scheduleSessionSync", () => {
	it("returns at once, tolerates repeats and a file that is gone", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-sync-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, "{}\n");
		expect(() => {
			scheduleSessionSync(file);
			scheduleSessionSync(file);
			scheduleSessionSync(path.join(dir, "missing.jsonl"));
		}).not.toThrow();
		// The sync runs once appends pause (250 ms).
		await new Promise((resolve) => setTimeout(resolve, 320));
		expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
		fs.rmSync(dir, { recursive: true, force: true });
		scheduleSessionSync(file);
		await new Promise((resolve) => setTimeout(resolve, 60));
	});

	it("marks a file whose sync failed until a flush recovers it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-sync-"));
		// A directory opens for reading but refuses "r+": the open fails, which is "nothing to sync", not a failed sync.
		scheduleSessionSync(dir);
		await new Promise((resolve) => setTimeout(resolve, 320));
		expect(sessionSyncFailed(dir)).toBe(false);
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, "{}\n");
		scheduleSessionSync(file);
		await new Promise((resolve) => setTimeout(resolve, 320));
		expect(sessionSyncFailed(file)).toBe(false);
		sessionSyncRecovered(file);
		expect(sessionSyncFailed(file)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
