import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compactions } from "../../../db/src/api.ts";
import { encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { archiveFolder } from "../../src/octocode/history/archive.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import { repairBeforeRead, repairCatalog } from "../../src/octocode/archive/repair-stamps.ts";
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
	/** A detail copy for `id`, so its row is complete. */
	const detail = (id: string, n: number) => {
		const folder = archiveFolder("s", env, root);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, `${n}-x-${id}.md`), "detail");
	};
	db.db.prepare("INSERT INTO sessions (id, file) VALUES ('s', ?)").run(file);
	return { db, env, file, write, detail };
}

it("parses only the header and the lines that can hold a compaction, so a broken message line does not stop it", async () => {
	const { db, env, file, write } = fixture();
	try {
		// A compaction whose type value is written with an escape still counts; a torn message line is never parsed.
		const escaped = JSON.stringify(compaction("escaped")).replace('"type":"compaction"', '"type":"\\u0063ompaction"');
		write(JSON.stringify(compaction("one")), '{"type":"message","id":"torn","te', escaped);
		await new HistoryRepair(db, env).transcript(file);
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one", "escaped"]);
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
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one"]);
		const reads = () => opened.mock.calls.filter(([name]) => String(name).endsWith(path.basename(file))).length;
		expect(reads()).toBe(1);
		await sweep();
		expect(reads()).toBe(1);

		// A new compaction changes the file: it is read and indexed.
		detail("two", 2);
		write(JSON.stringify(compaction("two")));
		await sweep();
		expect(reads()).toBe(2);
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
		await sweep();
		expect(reads()).toBe(2);

		// A row removed elsewhere (a purge) is recovered from the unchanged file.
		db.db.prepare("DELETE FROM compaction_summaries WHERE entry_id='two'").run();
		await sweep();
		expect(reads()).toBe(3);
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
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
		expect(compactions.forSession(db.db, "s")[0]?.detailState).toBe("missing");
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
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one"]);
		// Unchanged: nothing is read.
		await read();
		expect(transcript).toHaveBeenCalledTimes(1);
		// Appended lines: only they are read, from the end of the last read.
		const end = fs.statSync(file).size;
		write(JSON.stringify(compaction("two")));
		await read();
		expect(transcript.mock.calls.map(([, from]) => from)).toEqual([0, end]);
		expect(compactions.forSession(db.db, "s").map((row) => row.entryId)).toEqual(["one", "two"]);
	} finally {
		db.close();
	}
});

it("skips a session in scope whose transcript is unchanged since its last complete repair", async () => {
	const { db, env, file, write } = fixture();
	try {
		write(JSON.stringify(compaction("one")));
		const archive = vi
			.spyOn(HistoryRepair.prototype, "archive")
			.mockImplementation(async () => ({ file, verified: true, entries: 1, end: fs.statSync(file).size }));
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
		expect(compactions.forSession(db.db, "s").map((row) => [row.entryId, row.summary])).toEqual([
			["one", "summary one"],
			["two", "summary two"],
		]);
	} finally {
		db.close();
	}
});
