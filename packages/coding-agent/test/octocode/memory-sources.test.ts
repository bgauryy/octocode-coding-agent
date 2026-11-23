import path from "node:path";
import { describe, expect, it } from "vitest";
import { memorySources } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { MAX_MEMORY_SOURCES } from "../../src/octocode/memory/sources.ts";
import { describeMemory, MemoryError, MemoryStore } from "../../src/octocode/memory/store.ts";
import { tmp } from "./helpers.ts";

const A = "archive:s1/1/e1";
const B = "transcript:s1/e2";

function withStore(run: (store: MemoryStore, db: ReturnType<typeof openAgentDb>) => void) {
	const db = openAgentDb(path.join(tmp(), "memory.db"));
	try {
		run(new MemoryStore(db, "repo"), db);
	} finally {
		db.close();
	}
}
const rows = (db: ReturnType<typeof openAgentDb>, id: number) => memorySources.rowsOf(db.db, id);

describe("memory provenance", () => {
	it("keeps pending sources hidden until finalized, and shows final ones in get", () => {
		withStore((store, db) => {
			const { memory } = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A, B, A]);
			expect(rows(db, memory.id).map((r) => r.state)).toEqual(["pending", "pending"]);
			expect(store.sourcesOf(memory)).toEqual([]);
			store.finalizeSources(memory);
			expect(store.sourcesOf(memory).sort()).toEqual([A, B]);
			expect(describeMemory(memory, 2_000, store.sourcesOf(memory))).toContain(
				`sources: ${store.sourcesOf(memory).join(", ")}`,
			);
		});
	});

	it("shows no sources for a note saved without any", () => {
		withStore((store) => {
			const { memory } = store.set({ title: "Hand written", author: "user" }, 1_000);
			expect(store.sourcesOf(memory)).toEqual([]);
			expect(describeMemory(memory, 2_000, [])).not.toContain("sources:");
		});
	});

	it.each(["crash before the file replace", "crash after the replace, before finalize"])(
		"%s: next open finalizes once, with no duplicate",
		() => {
			withStore((store, db) => {
				const { memory } = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]);
				expect(store.reconcileSources()).toBe(1);
				expect(store.reconcileSources()).toBe(0);
				expect(rows(db, memory.id)).toEqual([{ revision: memory.updatedAt, anchor: A, state: "final" }]);
				expect(store.sourcesOf(memory)).toEqual([A]);
			});
		},
	);

	it("after finalize, a reopen changes nothing", () => {
		withStore((store, db) => {
			const { memory } = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]);
			store.finalizeSources(memory);
			store.reconcileSources();
			expect(rows(db, memory.id)).toHaveLength(1);
		});
	});

	it("drops pending sources of a revision the note no longer has, so no link follows an edit", () => {
		withStore((store, db) => {
			const first = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]).memory;
			// The note is edited by another path before the pending rows settle.
			const second = store.set({ id: first.id, body: "yarn, actually", author: "user" }, 2_000).memory;
			store.reconcileSources();
			expect(rows(db, first.id)).toEqual([]);
			expect(store.sourcesOf(second)).toEqual([]);
		});
	});

	it("unlinks final sources when the note's content changes, and replaces them on a new linked save", () => {
		withStore((store, db) => {
			const first = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]).memory;
			store.finalizeSources(first);
			const edited = store.set({ id: first.id, body: "changed", author: "user" }, 2_000).memory;
			expect(store.sourcesOf(edited)).toEqual([]);
			const relinked = store.set({ id: first.id, body: "again", author: "agent" }, 3_000, undefined, [B]).memory;
			store.finalizeSources(relinked);
			expect(store.sourcesOf(relinked)).toEqual([B]);
			expect(rows(db, first.id)).toHaveLength(1);
		});
	});

	it("removes a note's rows with the note", () => {
		withStore((store, db) => {
			const { memory } = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]);
			store.finalizeSources(memory);
			store.delete(memory.id);
			expect(rows(db, memory.id)).toEqual([]);
		});
	});

	it("refuses an invalid anchor and more than the bound, saving nothing", () => {
		withStore((store) => {
			expect(() => store.set({ title: "Bad link", author: "agent" }, 1_000, undefined, ["nonsense"])).toThrow(
				MemoryError,
			);
			const many = Array.from({ length: MAX_MEMORY_SOURCES + 1 }, (_, i) => `transcript:s1/e${i}`);
			expect(() => store.set({ title: "Too many", author: "agent" }, 1_000, undefined, many)).toThrow(/at most 8/);
			expect(store.list()).toEqual([]);
			const exact = many.slice(0, MAX_MEMORY_SOURCES);
			const { memory } = store.set({ title: "Exactly eight", author: "agent" }, 1_000, undefined, exact);
			store.finalizeSources(memory);
			expect(store.sourcesOf(memory)).toHaveLength(MAX_MEMORY_SOURCES);
		});
	});

	it("leaves out a stored anchor that no longer parses", () => {
		withStore((store, db) => {
			const { memory } = store.set({ title: "Use pnpm here", author: "agent" }, 1_000, undefined, [A]);
			store.finalizeSources(memory);
			db.db.prepare("INSERT INTO memory_sources VALUES (?, ?, 'junk', 'final', 1)").run(memory.id, memory.updatedAt);
			expect(store.sourcesOf(memory)).toEqual([A]);
		});
	});
});

describe("memory tool sources", () => {
	it("a set with sources is finalized by the tool and get shows them", async () => {
		const { createMemoryTool } = await import("../../src/octocode/native/tools/memory/tool.ts");
		const { fakeCtx, fakePermission } = await import("./fake-host.ts");
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const tool = createMemoryTool(() => store, { isSubagent: false, permission: fakePermission() });
			const ctx = { ...fakeCtx({ cwd: tmp() }), tools: [] } as never;
			const call = (input: Record<string, unknown>) => tool.execute("c", input as never, undefined, undefined, ctx);
			await call({ op: "set", scope: "project", title: "Prefer pnpm", sources: [A] });
			const id = store.list()[0].id;
			const text = (await call({ op: "get", id: `M${id}` })).content[0] as { text: string };
			expect(text.text).toContain(`sources: ${A}`);
			await expect(call({ op: "set", scope: "project", title: "Other fact", sources: ["bogus"] })).rejects.toThrow(
				/not a source anchor/,
			);
		} finally {
			db.close();
		}
	});
});
