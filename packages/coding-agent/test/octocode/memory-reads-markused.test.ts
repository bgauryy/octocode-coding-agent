import { describe, expect, it } from "vitest";
import { getMemory, readMemories } from "../../src/octocode/memory/reads.ts";
import type { Memory, MemoryStore } from "../../src/octocode/memory/store.ts";

// A rejected usage mark (queue full, writer closed, SQLite busy) loses only the mark, never the read.

const memory = {
	id: 7,
	title: "Release flow",
	body: "Publish from the tarball install check",
	keywords: "release",
	pinned: false,
	updatedAt: 1,
} as unknown as Memory;

function failingStore(): MemoryStore {
	return {
		get: (id: number) => (id === 7 ? memory : undefined),
		searchPage: () => undefined,
		scan: () => [memory],
		markUsed: () => Promise.reject(new Error("writer queue full")),
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
});
