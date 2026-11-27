import { describe, expect, it } from "vitest";
import { DbWriterBusyError } from "../../../db/src/api.ts";
import { getMemory, readMemories } from "../../src/octocode/memory/reads.ts";
import type { Memory, MemoryStore } from "../../src/octocode/memory/store.ts";

// A usage mark the writer cannot take now (queue full, writer closed, SQLite busy) loses only the mark, never the read;
// any other failure is a defect and propagates.

const memory = {
	id: 7,
	title: "Release flow",
	body: "Publish from the tarball install check",
	keywords: "release",
	pinned: false,
	updatedAt: 1,
} as unknown as Memory;

function failingStore(error: Error = new DbWriterBusyError("writer queue full")): MemoryStore {
	return {
		get: (id: number) => (id === 7 ? memory : undefined),
		sourcesOf: () => [],
		searchPage: () => undefined,
		scan: () => [memory],
		markUsed: () => Promise.reject(error),
	} as unknown as MemoryStore;
}

describe("memory reads when markUsed rejects", () => {
	it("get still returns the memory", async () => {
		await expect(getMemory(failingStore(), "M7")).resolves.toContain("Publish from the tarball install check");
	});

	it("search still returns the matches", async () => {
		const result = await readMemories(failingStore(), { op: "search", keywords: "release" });
		expect(result.hits).toBe(1);
		expect(result.text).toContain("Release flow");
	});

	it("lets an unexpected failure through instead of hiding it as a lost mark", async () => {
		await expect(getMemory(failingStore(new TypeError("bug in the mark")), "M7")).rejects.toThrow("bug in the mark");
	});
});
