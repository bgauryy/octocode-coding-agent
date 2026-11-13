import path from "node:path";
import { describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { selectInjection, TOTAL_BUDGET } from "../../src/octocode/memory/inject.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { tmp } from "./helpers.ts";

describe("memory injection text bounds", () => {
	it.each([false, true])("recalls oversized pinned titles with a retrieval pointer (body: %s)", (withBody) => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const title = `Pinned rule ${'"\\'.repeat(2_000)} final`;
			const body = withBody ? `Context ${'"\\'.repeat(2_000)} final` : "";
			const memory = store.set({ title, body, pinned: true, author: "test" }).memory;
			const injection = selectInjection(store, { query: "", scope: "all", seen: new Set(), topK: 0 });
			expect(injection?.ids).toEqual([memory.id]);
			expect(injection!.content.length).toBeLessThanOrEqual(TOTAL_BUDGET);
			const line = injection!.content.split("\n").find((text) => text.startsWith(`M${memory.id} `))!;
			expect(line.length).toBeLessThanOrEqual(600);
			expect(line).toContain(`(memory op=get id=M${memory.id})`);
			const quoted = line.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
			expect(quoted).toHaveLength(withBody ? 2 : 1);
			for (const value of quoted) expect(() => JSON.parse(value)).not.toThrow();
			expect(store.get(memory.id)).toMatchObject({ title, body });
		} finally {
			db.close();
		}
	});

	it("counts JSON escapes when clipping long bodies", () => {
		const db = openAgentDb(path.join(tmp(), "memory.db"));
		try {
			const store = new MemoryStore(db, "repo");
			const memory = store.set({
				title: "Short title",
				body: '"\\'.repeat(2_000),
				pinned: true,
				author: "test",
			}).memory;
			const injection = selectInjection(store, { query: "", scope: "all", seen: new Set(), topK: 0 });
			expect(injection?.ids).toEqual([memory.id]);
			const line = injection!.content.split("\n").find((text) => text.startsWith(`M${memory.id} `))!;
			expect(line.length).toBeLessThanOrEqual(600);
			expect(line).toContain('"Short title"');
			expect(line).toContain(`(memory op=get id=M${memory.id})`);
		} finally {
			db.close();
		}
	});
});
