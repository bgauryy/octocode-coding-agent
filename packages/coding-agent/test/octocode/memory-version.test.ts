import path from "node:path";
import { describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { selectInjection, unchangedIds } from "../../src/octocode/memory/inject.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { tmp } from "./helpers.ts";

describe("memory revisions used by recall", () => {
	it.each([1_000, 999, 2_000])("recalls changed content when the clock reads %i after a save at 1000", (now) => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const first = store.set(
				{ title: "Preferred response style", body: "Keep responses short", pinned: true, author: "user" },
				1_000,
			).memory;
			const injected = new Map([[first.id, first.updatedAt]]);
			store.set({ id: first.id, body: "Include test evidence", author: "user" }, now);
			const recall = selectInjection(store, { query: "", scope: "all", seen: unchangedIds(store, injected), topK: 0 });
			expect(recall?.ids).toEqual([first.id]);
			expect(recall?.content).toContain("Include test evidence");
			expect(store.get(first.id)!.updatedAt).toBeGreaterThan(first.updatedAt);
		} finally {
			db.close();
		}
	});
});
