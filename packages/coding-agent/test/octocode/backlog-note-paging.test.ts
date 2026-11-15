import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AgentDb, backlog, openDatabase } from "../../../db/src/api.ts";
import { getResult } from "../../src/octocode/backlog/tool-get.ts";
import type { Backlog } from "../../src/octocode/backlog/context.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const root = tmp("octocode-notes-page-");
	agent = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	agent.close();
});

function fixture() {
	const store = fixtureBacklog(() => agent, "fixture");
	const item = store.add({ title: "Page fixture", createdBy: "user" });
	// Equal timestamps exercise the id tie-break; a clock rollback must retain the timestamp ordering.
	agent.transaction(() => {
		for (let index = 0; index < 30; index++)
			backlog.addNote(
				agent.db,
				item.rowId,
				index % 3,
				"fixture",
				index % 2 ? "note" : "change",
				`entry-${index}: text`,
			);
	});
	const owner = { store, actor: { id: "fixture" } } as Backlog;
	const read = (offset = 0, changes = false, limit = 5) =>
		getResult(owner, { id: item.ref, offset, changes, limit }).content[0].text;
	return { store, item, read };
}

it("returns only the requested note page across the SQLite boundary", () => {
	const { read } = fixture();
	let noteRows = 0;
	const prepare = agent.db.prepare.bind(agent.db);
	vi.spyOn(agent.db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (/FROM backlog_notes\b/i.test(sql)) {
			const all = statement.all.bind(statement);
			vi.spyOn(statement, "all").mockImplementation((...args) => {
				const rows = all(...args);
				noteRows += rows.length;
				return rows;
			});
		}
		return statement;
	});
	const text = read();
	expect([...text.matchAll(/entry-(\d+):/g)]).toHaveLength(5);
	expect(text).toContain('"offset":5');
	expect(noteRows).toBeLessThanOrEqual(5);
});

it.each([false, true])("pages mixed note kinds without gaps or ordering changes (changes=%s)", (changes) => {
	const { store, item, read } = fixture();
	const all = store.notes(item, -1).filter((note) => changes || note.kind === "note");
	const seen: string[] = [];
	for (let offset = 0; offset < all.length; offset += 5) {
		const text = read(offset, changes);
		const ids = [...text.matchAll(/entry-(\d+):/g)].map((match) => match[1]);
		const expected = all
			.slice(Math.max(0, all.length - offset - 5), all.length - offset)
			.map((note) => note.text.match(/entry-(\d+):/)![1]);
		expect(ids).toEqual(expected);
		seen.push(...ids);
		expect(text.includes("Next: backlog")).toBe(offset + ids.length < all.length);
	}
	expect(new Set(seen).size).toBe(all.length);
	expect(read(all.length, changes)).not.toContain("Next: backlog");
	expect(read(all.length, changes)).not.toContain("entry-");
});
