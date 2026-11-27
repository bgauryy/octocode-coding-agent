import path from "node:path";
import { expect, it } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { readMemories } from "../../src/octocode/memory/reads.ts";
import { MemoryStore } from "../../src/octocode/memory/store.ts";
import { tmp } from "./helpers.ts";

it("keeps keyword fallback matches in the indexed note fields, not provenance metadata", async () => {
	const db = openAgentDb(path.join(tmp(), "memory.db"));
	try {
		const indexed = new MemoryStore(db, "repo");
		const metadataOnly = indexed.set({
			title: "Window settings",
			body: "Use compact layout",
			author: "authorSentinel",
		}).memory;
		const actual = indexed.set({
			title: "Build command",
			body: "Run authorSentinel after compilation",
			author: "user",
		}).memory;
		const fallback = new MemoryStore({ ...db, fts: false, transaction: db.transaction.bind(db) }, "repo");
		const found = await readMemories(fallback, { op: "search", keywords: "authorsentinel" });
		expect(found.hits).toBe(1);
		expect(found.text).toContain(`M${actual.id}\n`);
		expect(found.text).not.toContain(`M${metadataOnly.id}\n`);
		if (db.fts) {
			const fullText = await readMemories(indexed, { op: "search", keywords: "authorsentinel" });
			expect(fullText.hits).toBe(found.hits);
		}
		const provenance = await readMemories(fallback, { op: "search", query: "author: authorSentinel" });
		expect(provenance.hits).toBe(1);
		expect(provenance.text).toContain(`M${metadataOnly.id}\n`);
	} finally {
		db.close();
	}
});
