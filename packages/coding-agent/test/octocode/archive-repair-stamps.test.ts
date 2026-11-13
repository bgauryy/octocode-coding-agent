import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { compactions } from "../../../db/src/api.ts";
import { encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { archiveFolder } from "../../src/octocode/history/archive.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import {
	repairBeforeRead,
	repairCatalog,
	repairOnStart,
	writeOwnRows,
} from "../../src/octocode/archive/repair-stamps.ts";
import { saveCompaction } from "../../src/octocode/archive/summaries.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

const timestamp = "2026-01-01T00:00:00Z";
const compaction = (id: string) => ({
	type: "compaction",
	id,
	parentId: null,
	timestamp,
	summary: `summary ${id}`,
	firstKeptEntryId: "kept",
	tokensBefore: 100,
});

function fixture() {
	const root = tmp();
	const db = openAgentDb(path.join(root, "agent.db"));
	registeredWorkspace(root, db);
	const env = { OCTOCODE_HOME: path.join(root, "home") };
	const file = path.join(root, "s.jsonl");
	const header = { type: "session", version: 3, id: "s", cwd: root, timestamp };
	const lines = [JSON.stringify(header), JSON.stringify({ type: "message", id: "m0", text: "compaction talk" })];
	const write = (...more: string[]) => {
		lines.push(...more);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
	};
	/** Rewrite line `index` in place (same inode), as an edit of the file's history would. */
	const rewrite = (index: number, line: string) => {
		lines[index] = line;
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
	};
	/** A detail copy for `id`, so its row is complete. */
	const detail = (id: string, n: number) => {
		const folder = archiveFolder("s", env, root);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, `${n}-x-${id}.md`), "detail");
	};
	db.db.prepare("INSERT INTO sessions (id, file) VALUES ('s', ?)").run(file);
	return { db, env, root, file, write, rewrite, detail };
}

it("parses only the header and the lines that can hold a compaction, so a broken message line does not stop it", async () => {
	const { db, env, file, write } = fixture();
	try {
		// A compaction whose type value is written with an escape still counts; a torn message line is never parsed.
		const escaped = JSON.stringify(compaction("escaped")).replace('"type":"compaction"', '"type":"\\u0063ompaction"');
		write(JSON.stringify(compaction("one")), '{"type":"message","id":"torn","te', escaped);
		await new HistoryRepair(db, env).transcript(file);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one", "escaped"]);
	} finally {
		db.close();
	}
});

it("skips a transcript the last sweep repaired completely, and reads it again once it or its rows change", async () => {
	const { db, env, file, write, detail } = fixture();
	try {
		detail("one", 1);
		write(JSON.stringify(compaction("one")));
		const opened = vi.spyOn(fs.promises, "open");
		const sweep = () => repairCatalog(db, new HistoryRepair(db, env));
		await sweep();
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one"]);
		const reads = () => opened.mock.calls.filter(([name]) => String(name).endsWith(path.basename(file))).length;
		expect(reads()).toBe(1);
		await sweep();
		expect(reads()).toBe(1);

		// A new compaction changes the file: it is read and indexed.
		detail("two", 2);
		write(JSON.stringify(compaction("two")));
		await sweep();
		expect(reads()).toBe(2);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
		await sweep();
		expect(reads()).toBe(2);

		// A row removed elsewhere (a purge) is recovered from the unchanged file.
		db.mirror.db.prepare("DELETE FROM compaction_summaries WHERE entry_id='two'").run();
		await sweep();
		expect(reads()).toBe(3);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
	} finally {
		db.close();
	}
});

it("reads a transcript again at every sweep while a row it holds is incomplete", async () => {
	const { db, env, file, write } = fixture();
	try {
		// No detail copy: the row stays `missing`, and a later copy must still be attached.
		write(JSON.stringify(compaction("one")));
		const opened = vi.spyOn(fs.promises, "open");
		const reads = () => opened.mock.calls.filter(([name]) => String(name).endsWith(path.basename(file))).length;
		await repairCatalog(db, new HistoryRepair(db, env));
		await repairCatalog(db, new HistoryRepair(db, env));
		expect(reads()).toBe(2);
		expect(compactions.forSession(db.mirror.db, "s")[0]?.detailState).toBe("missing");
	} finally {
		db.close();
	}
});

it("repairs this session's transcript before a read only from where the last complete read ended", async () => {
	const { db, env, file, write } = fixture();
	try {
		write(JSON.stringify(compaction("one")));
		const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
		const read = () => repairBeforeRead(db, new HistoryRepair(db, env), file, []);
		expect(await read()).toEqual([]);
		expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0]);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one"]);
		// Unchanged: nothing is read.
		await read();
		expect(transcript).toHaveBeenCalledTimes(1);
		// Appended lines: only they are read, from the end of the last read.
		const end = fs.statSync(file).size;
		write(JSON.stringify(compaction("two")));
		await read();
		expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0, end]);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
	} finally {
		db.close();
	}
});

it("skips a session in scope whose transcript is unchanged since its last complete repair", async () => {
	const { db, env, file, write } = fixture();
	try {
		write(JSON.stringify(compaction("one")));
		const archive = vi.spyOn(HistoryRepair.prototype, "archive").mockImplementation(async () => ({
			file,
			verified: true,
			entries: 1,
			end: fs.statSync(file).size,
			session: "s",
		}));
		const scope = [{ id: "s", folder: path.join(env.OCTOCODE_HOME, "s", "archive"), transcript: file }];
		const read = () => repairBeforeRead(db, new HistoryRepair(db, env), undefined, scope);
		await read();
		await read();
		expect(archive).toHaveBeenCalledTimes(1);
		// A read's stamp is the sweep's format: the sweep skips the file and keeps it, and the read after it skips it too.
		await repairCatalog(db, new HistoryRepair(db, env));
		await read();
		expect(archive).toHaveBeenCalledTimes(1);
		write(JSON.stringify(compaction("two")));
		await read();
		expect(archive).toHaveBeenCalledTimes(2);
		// A failed repair is a coverage line, and the read goes on.
		archive.mockRejectedValueOnce(new Error("disk gone"));
		write(JSON.stringify(compaction("three")));
		expect(await read()).toEqual(["Historical recovery incomplete: disk gone"]);
	} finally {
		db.close();
	}
});

it("indexes the compactions of a transcript in the session codec's format, whose system parts are references", async () => {
	const { db, env, file } = fixture();
	try {
		const prompt = "system prompt ".repeat(60);
		const header = { type: "session", version: 3, id: "s", cwd: path.dirname(file), timestamp };
		const withSystem = (id: string) => ({ ...compaction(id), systemMessage: { role: "system", content: prompt } });
		const { lines } = encodeSessionLines([header, withSystem("one"), withSystem("two")]);
		expect(lines[2]).toContain('"$ref"');
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		await new HistoryRepair(db, env).transcript(file);
		expect(compactions.forSession(db.mirror.db, "s").map((row) => [row.entryId, row.summary])).toEqual([
			["one", "summary one"],
			["two", "summary two"],
		]);
	} finally {
		db.close();
	}
});

describe("a session start", () => {
	const rows = (db: ReturnType<typeof openAgentDb>) =>
		compactions
			.forSession(db.mirror.db, "s")
			.map((row) => [row.entryId, row.summary, row.originVerified, row.detailState, row.detailFile]);

	it("reads only what the transcript appended since the last complete repair, in a new process too", async () => {
		const { db, env, file, write, detail } = fixture();
		try {
			detail("one", 1);
			write(JSON.stringify(compaction("one")));
			const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
			// Each start uses a fresh repair, as a resumed process does; nothing in this process's memory is needed.
			const start = () => repairOnStart(db, new HistoryRepair(db, env), file);
			await start();
			await start();
			expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0]);
			const end = fs.statSync(file).size;
			detail("two", 2);
			const appended = [
				JSON.stringify({ type: "message", id: "m1", text: "x".repeat(10_000) }),
				JSON.stringify(compaction("two")),
			];
			write(...appended);
			await start();
			expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0, end]);

			// The same rows as a whole-file repair of the same transcript into an empty database.
			const whole = fixture();
			try {
				whole.detail("one", 1);
				whole.detail("two", 2);
				// The same lines; only the header's folder differs.
				whole.write(JSON.stringify(compaction("one")), ...appended);
				await new HistoryRepair(whole.db, whole.env).transcript(whole.file);
				const normalize = (list: unknown[][]) =>
					list.map(([id, summary, verified, state, detailFile]) => [
						id,
						summary,
						verified,
						state,
						typeof detailFile === "string" ? path.basename(detailFile) : detailFile,
					]);
				expect(normalize(rows(db))).toEqual(normalize(rows(whole.db)));
				expect(rows(db).map(([id]) => id)).toEqual(["one", "two"]);
			} finally {
				whole.db.close();
			}
		} finally {
			db.close();
		}
	});

	it("reads the whole file when its history changed in place, its rows changed, or the saved offset is unreadable", async () => {
		const { db, env, file, write, rewrite, detail } = fixture();
		try {
			detail("one", 1);
			detail("two", 2);
			write(JSON.stringify(compaction("one")));
			const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
			const start = () => repairOnStart(db, new HistoryRepair(db, env), file);
			const froms = () => transcript.mock.calls.map(([, from]) => from);
			await start();
			// Same inode, same size or longer, different earlier bytes: the offset is not trusted.
			rewrite(1, JSON.stringify({ type: "message", id: "m0", text: "compaction tale" }));
			write(JSON.stringify(compaction("two")));
			await start();
			expect(froms()).toEqual([0, 0]);
			expect(rows(db).map(([id]) => id)).toEqual(["one", "two"]);

			// A row removed elsewhere (a purge) is recovered from the unchanged file.
			db.mirror.db.prepare("DELETE FROM compaction_summaries WHERE entry_id='one'").run();
			await start();
			expect(froms()).toEqual([0, 0, 0]);
			expect(rows(db).map(([id]) => id)).toEqual(["two", "one"]);

			// A file replaced by a rename (a new inode) is read whole.
			fs.copyFileSync(file, `${file}.new`);
			fs.renameSync(`${file}.new`, file);
			write(JSON.stringify({ type: "message", id: "m2", text: "more" }));
			await start();
			expect(froms()).toEqual([0, 0, 0, 0]);

			// Unreadable saved offsets fail open to a whole read.
			db.db.prepare("UPDATE meta SET value = '{not json' WHERE key = 'archive_repair_offsets'").run();
			write(JSON.stringify({ type: "message", id: "m3", text: "more" }));
			await start();
			expect(froms()).toEqual([0, 0, 0, 0, 0]);
			// Unchanged since a complete repair: nothing is read.
			await start();
			expect(froms()).toEqual([0, 0, 0, 0, 0]);
		} finally {
			db.close();
		}
	});

	it("keeps reading from the saved offset after a compaction this process wrote; a change elsewhere still reads it whole", async () => {
		const { db, env, root, file, write, detail } = fixture();
		try {
			detail("one", 1);
			write(JSON.stringify(compaction("one")));
			const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
			const start = () => repairOnStart(db, new HistoryRepair(db, env), file);
			const froms = () => transcript.mock.calls.map(([, from]) => from);
			await start();
			const end = fs.statSync(file).size;
			// A live compaction: the transcript gains its entry and its archive segment, and the session writes its row.
			const live = (id: string, n: number) => {
				detail(id, n);
				const entry = compaction(id);
				write(JSON.stringify(entry));
				writeOwnRows(db, file, "s", () =>
					saveCompaction(db, root, "s", entry as CompactionEntry, { transcript: file, env }),
				);
			};
			live("two", 2);
			await start();
			expect(froms()).toEqual([0, end]);
			expect(rows(db).map(([id]) => id)).toEqual(["one", "two"]);

			// A row changed elsewhere before this process writes its own: the offset no longer vouches for the rows.
			db.mirror.db.prepare("UPDATE compaction_summaries SET summary = 'purged' WHERE entry_id = 'one'").run();
			live("three", 3);
			await start();
			expect(froms()).toEqual([0, end, 0]);
			expect(rows(db).find(([id]) => id === "one")?.[1]).toBe("summary one");

			// A row changed elsewhere after this process's write commits: read whole too.
			live("four", 4);
			db.mirror.db.prepare("UPDATE compaction_summaries SET summary = 'purged' WHERE entry_id = 'two'").run();
			await start();
			expect(froms()).toEqual([0, end, 0, 0]);
		} finally {
			db.close();
		}
	});

	it("a start that finds nothing appended leaves this process's first read nothing to read either", async () => {
		const { db, env, file, write, detail } = fixture();
		try {
			detail("one", 1);
			write(JSON.stringify(compaction("one")));
			await repairOnStart(db, new HistoryRepair(db, env), file);
			// A new process: its own memory of what it read is empty.
			vi.resetModules();
			const fresh = await import("../../src/octocode/archive/repair-stamps.ts");
			const { HistoryRepair: FreshRepair } = await import("../../src/octocode/archive/repair.ts");
			const transcript = vi.spyOn(FreshRepair.prototype, "transcript");
			await fresh.repairOnStart(db, new FreshRepair(db, env), file);
			expect(transcript).not.toHaveBeenCalled();
			expect(await fresh.repairBeforeRead(db, new FreshRepair(db, env), file, [])).toEqual([]);
			expect(transcript).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	});

	it("reads the whole file again while a row it holds is incomplete", async () => {
		const { db, env, file, write } = fixture();
		try {
			// No detail copy: the row is `missing`, and the next start must still look for one.
			write(JSON.stringify(compaction("one")));
			const transcript = vi.spyOn(HistoryRepair.prototype, "transcript");
			await repairOnStart(db, new HistoryRepair(db, env), file);
			await repairOnStart(db, new HistoryRepair(db, env), file);
			expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0, 0]);
		} finally {
			db.close();
		}
	});
});
