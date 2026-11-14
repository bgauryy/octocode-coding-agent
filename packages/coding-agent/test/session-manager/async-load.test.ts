import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { loadSessionFile, loadSessionFileAsync } from "../../src/core/session-manager/file-reader.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { userMsg } from "../utilities.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-async-"));
});
afterEach(async () => {
	await sessionMirrorSettled();
	rmSync(dir, { recursive: true, force: true });
});

it("loads and indexes encoded records once, preserving labels, UTF-8 and a malformed tail", async () => {
	const source = SessionManager.inMemory(dir);
	const first = source.appendMessage(userMsg("שלום 🌊"));
	source.appendLabelChange(first, "keep");
	for (let i = 0; i < 6000; i++) source.appendCustomEntry("row", { i, text: "🌊".repeat(80) });
	const file = join(dir, "large.jsonl");
	writeFileSync(
		file,
		encodeSessionLines([source.getHeader()!, ...source.getEntries()]).lines.join("\n") + '\n{"torn":',
	);
	const expected = loadSessionFile(file);
	const loaded = await loadSessionFileAsync(file);
	expect(loaded.entries).toEqual(expected.entries);
	expect([...loaded.byId]).toEqual([...expected.byId]);
	expect(loaded.labelsById.get(first)).toBe("keep");
	expect(loaded.leafId).toBe(source.getLeafId());
	const opened = await SessionManager.openAsync(file);
	expect(opened.getCwd()).toBe(source.getCwd());
	expect(opened.getEntries()).toEqual(source.getEntries());
	expect(opened.getLabel(first)).toBe("keep");
});

it("can abort a large load between batches and leaves its file readable", async () => {
	const source = SessionManager.inMemory(dir);
	const file = join(dir, "abort.jsonl");
	writeFileSync(
		file,
		JSON.stringify(source.getHeader()) +
			"\n" +
			Array.from({ length: 30000 }, (_, i) =>
				JSON.stringify({ type: "custom", id: String(i), parentId: null, data: "x".repeat(300) }),
			).join("\n"),
	);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10);
	try {
		await expect(loadSessionFileAsync(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		clearTimeout(timer);
	}
	expect((await loadSessionFileAsync(file)).entries).toHaveLength(30001);
});

it("rejects an already cancelled open and preserves the synchronous missing-file behavior", async () => {
	const file = join(dir, "missing.jsonl");
	await expect(SessionManager.openAsync(file, undefined, undefined, AbortSignal.abort())).rejects.toMatchObject({
		name: "AbortError",
	});
	expect((await loadSessionFileAsync(file)).entries).toEqual([]);
});
