import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { injectedIds, MEMORY_MESSAGE_TYPE, selectInjection, unchangedIds } from "../../src/octocode/memory/inject.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { tmp } from "./helpers.ts";

describe("bounded memory retrieval", () => {
	it.each([true, false])("finds unseen memories beyond the usual retrieval window (FTS: %s)", (fts) => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		const store = new MemoryStore({ ...db, fts }, "repo-a");
		try {
			for (const word of [
				"alpha",
				"bravo",
				"charlie",
				"delta",
				"echo",
				"foxtrot",
				"golf",
				"hotel",
				"india",
				"juliet",
				"kilo",
				"lima",
				"mike",
				"november",
				"oscar",
				"papa",
				"quebec",
				"romeo",
				"sierra",
				"tango",
			]) {
				store.set({ title: `Rewind ${word}`, author: "test" });
			}
			const ranked = store.search("rewind", "all", 20);
			expect(ranked).toHaveLength(20);
			const unseen = ranked.at(-1)!;
			const seen = new Set(ranked.slice(0, -1).map((memory) => memory.id));
			expect(selectInjection(store, { query: "rewind", scope: "all", seen, topK: 1 })?.ids).toEqual([unseen.id]);
		} finally {
			db.close();
		}
	});

	it("keeps the retrieval limit independent of memories already seen", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			const search = vi.spyOn(store, "search");
			selectInjection(store, {
				query: "rewind checkpoints",
				scope: "all",
				seen: new Set(Array.from({ length: 10_000 }, (_, i) => i)),
				topK: 5,
			});
			expect(search.mock.calls[0][2]).toBeLessThanOrEqual(15);
		} finally {
			db.close();
		}
	});
});

describe("relevance filtering of injected hits", () => {
	it("fetches more hits than topK, so irrelevant top hits do not crowd out a relevant one", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			// One matched body word is not relevant; a title word is. The two body-only memories rank above the title match.
			const noise = ["alpha", "bravo"].map(
				(word) => store.set({ title: `Note ${word}`, body: "rewind", author: "test" }).memory,
			);
			const wanted = store.set({ title: "Rewind rule", author: "test" }).memory;
			const ranked = [...noise, wanted].map((memory, index) => ({ ...memory, score: 3 - index }));
			vi.spyOn(store, "search").mockImplementation((_query, _scope, limit = 10) => ranked.slice(0, limit));
			const injection = selectInjection(store, { query: "rewind", scope: "all", seen: new Set(), topK: 1 });
			expect(injection?.ids).toEqual([wanted.id]);
		} finally {
			db.close();
		}
	});
});

describe("pinned memories beyond one injection", () => {
	it("counts every held-back pinned memory, and reaches those past the first 50 once the rest were seen", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			const ids = Array.from(
				{ length: 55 },
				(_, i) => store.set({ title: `Rule zq${i}x`, pinned: true, author: "test" }, 1000 + i).memory.id,
			);
			const first = selectInjection(store, { query: "", scope: "all", seen: new Set(), topK: 5 })!;
			expect(first.ids.length).toBeGreaterThan(0);
			expect(first.content.split("\n").at(-1)).toBe(
				`[${55 - first.ids.length} more pinned memories did not fit here; call memory with op "list" to read them.]`,
			);
			// The 50 newest were injected earlier: the 5 oldest come now, and nothing is held back.
			const seen = new Set(ids.slice(5));
			const rest = selectInjection(store, { query: "", scope: "all", seen, topK: 5 });
			expect(rest?.ids.sort((a, b) => a - b)).toEqual(ids.slice(0, 5));
			expect(rest?.content).not.toMatch(/did not fit/);
		} finally {
			db.close();
		}
	});
});

describe("injected ids across a compaction", () => {
	it("keeps the ids injected from the compaction's first kept entry on", () => {
		const message = (ids: unknown[]) => ({
			type: "custom_message",
			customType: MEMORY_MESSAGE_TYPE,
			content: "x",
			details: { ids },
		});
		// A compaction keeps the entries from its first kept entry on: injections there are still in context.
		const kept = [
			{ ...message([1]), id: "m1" },
			{ ...message([2]), id: "m2" },
			{ ...message([3]), id: "m3" },
		];
		expect([...injectedIds([...kept, { type: "compaction", firstKeptEntryId: "m2" }, message([4])]).keys()]).toEqual([
			2, 3, 4,
		]);
		// A later compaction counts from its own first kept entry; one whose kept entry is not on the branch drops all.
		expect([
			...injectedIds([
				...kept,
				{ type: "compaction", firstKeptEntryId: "m2" },
				{ ...message([4]), id: "m4" },
				{ type: "compaction", firstKeptEntryId: "m4" },
			]).keys(),
		]).toEqual([4]);
		expect([...injectedIds([...kept, { type: "compaction", firstKeptEntryId: "gone" }]).keys()]).toEqual([]);
	});
});

describe("edited and long memories", () => {
	it("sends a memory again once it was edited after its injection; an injection without versions still counts", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			const memory = store.set({ title: "Rewind notes", author: "test" }, 1_000).memory;
			const first = selectInjection(store, { query: "rewind", scope: "all", seen: new Set(), topK: 5 })!;
			expect(first.updated).toEqual([1_000]);
			const branch = [
				{
					type: "custom_message",
					customType: MEMORY_MESSAGE_TYPE,
					content: first.content,
					details: { ids: first.ids, updated: first.updated },
				},
			];
			expect(injectedIds(branch)).toEqual(new Map([[memory.id, 1_000]]));
			expect(
				selectInjection(store, {
					query: "rewind",
					scope: "all",
					seen: unchangedIds(store, injectedIds(branch)),
					topK: 5,
				}),
			).toBeUndefined();
			store.set({ id: memory.id, title: "Rewind notes", body: "now with a body", author: "test" }, 2_000);
			expect(
				selectInjection(store, {
					query: "rewind",
					scope: "all",
					seen: unchangedIds(store, injectedIds(branch)),
					topK: 5,
				})?.ids,
			).toEqual([memory.id]);
			const legacy = [
				{ type: "custom_message", customType: MEMORY_MESSAGE_TYPE, content: "x", details: { ids: [memory.id] } },
			];
			expect(unchangedIds(store, injectedIds(legacy))).toEqual(new Set([memory.id]));
		} finally {
			db.close();
		}
	});

	it("ends a memory line cut for the injection with the call that reads it whole", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			const memory = store.set({ title: "Rewind notes", body: "word ".repeat(290), author: "test" }).memory;
			const line = selectInjection(store, {
				query: "rewind",
				scope: "all",
				seen: new Set(),
				topK: 5,
			})!.content.split("\n")[1];
			expect(line.length).toBeLessThanOrEqual(600);
			expect(line.endsWith(`…" (memory get M${memory.id})`)).toBe(true);
		} finally {
			db.close();
		}
	});
});

describe("pinned memories over the budget", () => {
	it("says how many pinned memories it held back and how to read them, without cutting any", () => {
		const db = openAgentDb(path.join(tmp(), "memory.sqlite"));
		try {
			const store = new MemoryStore(db, "repo-a");
			for (const name of ["one", "two", "three", "four"])
				store.set({ title: `Pinned ${name}`, body: `${name} `.repeat(100), pinned: true, author: "test" });
			const injection = selectInjection(store, { query: "", scope: "all", seen: new Set(), topK: 5 })!;
			expect(injection.ids).toHaveLength(2);
			expect(injection.content.split("\n").at(-1)).toBe(
				'[2 more pinned memories did not fit here; call memory with op "list" to read them.]',
			);
			// Held-back memories are not recorded as injected, so a later prompt still brings them.
			const later = selectInjection(store, { query: "", scope: "all", seen: new Set(injection.ids), topK: 5 })!;
			expect(later.ids).toHaveLength(2);
			expect(later.content).not.toContain("did not fit");
		} finally {
			db.close();
		}
	});
});
