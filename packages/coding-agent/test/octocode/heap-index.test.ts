import fs from "node:fs";
import path from "node:path";
import type { ToolResultEvent } from "../../src/core/features/index.ts";
import { describe, expect, it } from "vitest";
import {
	expiredReply,
	fileHandle,
	HEAP_INDEX_CAP,
	HeapIndex,
	ParentHeap,
	savedHandle,
} from "../../src/octocode/shared/heap-index.ts";
import { expiredHandleReply } from "../../src/octocode/files/expired-handles.ts";
import { sessionHeap } from "../../src/octocode/shared/session-heap.ts";
import { protectedFileRefusal } from "../../src/octocode/files/tool/protected-files.ts";
import { sessionTempRoot } from "../../src/octocode/shared/home.ts";
import { tmp } from "./helpers.ts";

const view = (index: HeapIndex, file: string, version = "sha:" + "a".repeat(64)) =>
	index.record({ path: file, range: "all", version, callId: `c-${file}` });

describe("heap index", () => {
	it("names a version by its content digest and a range by its lines", () => {
		expect(fileHandle(`sha:${"ab".repeat(32)}`)).toBe("file:abababababab");
		expect(fileHandle(`sha:${"ab".repeat(32)}`, [3, 9])).toBe("file:abababababab@3-9");
		expect(fileHandle("stat:1:2")).toMatch(/^file:[a-f0-9]{12}$/);
		expect(fileHandle("stat:1:2")).not.toBe(fileHandle("stat:1:3"));
	});

	it("is bounded and evicts the oldest used entry first", () => {
		const index = new HeapIndex(3);
		for (const name of ["/a", "/b", "/c"]) view(index, name);
		// Using /a makes /b the oldest.
		expect(index.find("/a", "all")).toBeDefined();
		view(index, "/d");
		expect(index.size).toBe(3);
		expect(index.find("/b", "all")).toBeUndefined();
		expect(index.find("/a", "all")).toBeDefined();
		const full = new HeapIndex();
		for (let n = 0; n < HEAP_INDEX_CAP + 50; n++) view(full, `/f${n}`);
		expect(full.size).toBe(HEAP_INDEX_CAP);
		expect(full.find("/f0", "all")).toBeUndefined();
		expect(full.find(`/f${HEAP_INDEX_CAP + 49}`, "all")).toBeDefined();
	});

	it("keeps one entry per file and range, the latest version winning", () => {
		const index = new HeapIndex();
		view(index, "/a", `sha:${"1".repeat(64)}`);
		const latest = view(index, "/a", `sha:${"2".repeat(64)}`);
		expect(index.size).toBe(1);
		expect(index.find("/a", "all")?.handle).toBe(latest.handle);
	});
});

describe("a child's read-only view of its parent's heap", () => {
	it("resolves a parent handle to a path to read and has no way to change the parent's index", () => {
		const dir = tmp("heap-");
		const file = path.join(dir, "saved.txt");
		fs.writeFileSync(file, "x");
		const parent = new HeapIndex();
		const entry = parent.record({ path: file, range: "all", version: "sha:" + "e".repeat(64), callId: "c1" });
		const child = new ParentHeap(parent.entries());
		expect(child.resolve(entry.handle)).toEqual({ status: "ok", path: file });
		// Later changes in the parent do not move the child's frozen copy, and the view exposes no mutator.
		parent.record({ path: "/other", range: "all", version: "sha:" + "f".repeat(64), callId: "c2" });
		expect(child.size).toBe(1);
		expect(Object.getOwnPropertyNames(Object.getPrototypeOf(child)).sort()).toEqual(["constructor", "resolve", "size"]);
	});

	it("cannot write through a handle: the file tool refuses every path in Octocode's state folder", () => {
		const saved = path.join(sessionTempRoot(), "parent-session", "output", "result.txt");
		expect(protectedFileRefusal(saved, saved, process.cwd())).toMatch(/\S/);
	});

	it("replies that an unknown or deleted handle expired", () => {
		const dir = tmp("heap-");
		const file = path.join(dir, "gone.txt");
		fs.writeFileSync(file, "x");
		const parent = new HeapIndex();
		const entry = parent.record({ path: file, range: "all", version: "sha:" + "9".repeat(64), callId: "c1" });
		const child = new ParentHeap(parent.entries());
		fs.rmSync(file);
		expect(child.resolve(entry.handle)).toEqual({ status: "expired", reply: expiredReply(entry.handle) });
		expect(child.resolve("file:000000000000")).toMatchObject({ status: "expired" });
		expect(expiredReply("file:000000000000")).toContain("expired");
	});
});

describe("handles across a spawn and after a sweep", () => {
	const failed = (input: unknown, text: string, isError = true): ToolResultEvent =>
		({ toolName: "localFetch", toolCallId: "t1", input, isError, content: [{ type: "text", text }] }) as never;

	it("a child loads the parent's handles from the handoff file and the index stays its own", () => {
		const dir = tmp("heap-");
		const file = path.join(dir, "held.txt");
		fs.writeFileSync(file, "x");
		const parent = new HeapIndex();
		const entry = parent.record({ path: file, range: "all", version: "sha:" + "7".repeat(64), callId: "c1" });
		const handoff = path.join(dir, "heap.json");
		fs.writeFileSync(handoff, JSON.stringify(parent.entries()));
		const owner = {};
		const heap = sessionHeap(owner, { OCTOCODE_PARENT_HEAP_FILE: handoff });
		expect(heap?.parent?.resolve(entry.handle)).toEqual({ status: "ok", path: file });
		expect(heap?.index.size).toBe(0);
		expect(sessionHeap(owner)).toBe(heap);
		expect(sessionHeap(undefined)).toBeUndefined();
		fs.rmSync(handoff);
		expect(sessionHeap({}, { OCTOCODE_PARENT_HEAP_FILE: handoff })?.parent).toBeUndefined();
	});

	it("replies expired for an unknown handle and names the path of a handle that still resolves", () => {
		const dir = tmp("heap-");
		const file = path.join(dir, "held.txt");
		fs.writeFileSync(file, "x");
		const heap = sessionHeap({}, {});
		const entry = heap!.index.record({ path: file, range: "all", version: "sha:" + "6".repeat(64), callId: "c1" });
		const unknown = "file:000000000000";
		expect(expiredHandleReply(failed({ path: unknown }, "not found"), heap)).toBe(expiredReply(unknown));
		expect(expiredHandleReply(failed({ path: entry.handle }, "not found"), heap)).toContain(file);
		expect(expiredHandleReply(failed({ path: "saved:00000000" }, "not found"), heap)).toContain("expired");
	});

	it("replies expired for a swept saved result path and leaves other failures alone", () => {
		const gone = path.join(sessionTempRoot(), "swept-session", "output", "result-1.txt");
		const reply = expiredHandleReply(failed({ path: gone }, `ENOENT: no such file ${gone}`), undefined);
		expect(reply).toBe(expiredReply(savedHandle(gone)));
		expect(
			expiredHandleReply(failed({ path: "/tmp/other.txt" }, "ENOENT: no such file /tmp/other.txt"), undefined),
		).toBeUndefined();
		expect(expiredHandleReply(failed({}, "boom", false), undefined)).toBeUndefined();
	});
});
