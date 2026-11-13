import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, type FileStamp, openDatabase, transcripts } from "../src/api.ts";
import { runTranscriptCommand, type TranscriptCommand } from "../src/writer/transcript-mirror.ts";
import { getFileStamp } from "../../common/src/paths.ts";
import { tmp } from "./helpers.ts";

let dir: string;
let agent: AgentDb;
let other: AgentDb;
beforeEach(() => {
	dir = tmp();
	const locations = {
		file: path.join(dir, "save.db"),
		mirrorFile: path.join(dir, "save.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	agent = openDatabase(locations);
	other = openDatabase(locations);
});
afterEach(() => {
	agent.close();
	other.close();
});

const workspace = { id: "ws-save", root: "/r/save", name: "save", binding: "1:1" };
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "x", cwd: "/r/save" });
const line = (id: string, n: number, tag: string) =>
	JSON.stringify({ type: "custom", id: `${id}-${n}`, parentId: n ? `${id}-${n - 1}` : null, data: `${tag}${n}` });
const row = (json: string) => {
	const value = JSON.parse(json) as { id: string; parentId: string | null; type: string };
	return { id: value.id, parentId: value.parentId, type: value.type, json };
};

/** Writes the session file with `count` entries tagged `tag` (a different tag changes every line) and its save command. */
function snapshot(id: string, count: number, tag: string, pad = 0): Extract<TranscriptCommand, { kind: "save" }> {
	const file = path.join(dir, `${id}.jsonl`);
	const lines = Array.from({ length: count }, (_, n) => line(id, n, `${tag}${"p".repeat(pad)}`));
	// Replaced as a rewrite does (a new file in its place), so a shorter file is not taken for an older snapshot.
	fs.writeFileSync(`${file}.tmp`, [header(id), ...lines].map((each) => `${each}\n`).join(""));
	fs.renameSync(`${file}.tmp`, file);
	const stamp: FileStamp = getFileStamp(file);
	return {
		kind: "save",
		sessionId: id,
		file: fs.realpathSync(file),
		stamp,
		header: header(id),
		records: lines.map(row),
		workspace,
	};
}
const stored = (db: AgentDb, id: string) => transcripts.records(db.mirror.db, id).slice(1);
const rowIds = (id: string) =>
	(
		other.mirror.db.prepare("SELECT rowid AS r FROM session_entries WHERE session_id=? ORDER BY position").all(id) as {
			r: number;
		}[]
	).map((each) => each.r);

describe("transcript save in the database writer", () => {
	it("writes only the entries past the stored prefix when the stored rows are the start of the new transcript", () => {
		const first = snapshot("s-tail", 5, "a");
		expect(runTranscriptCommand(agent, first)).toBe("saved");
		const before = rowIds("s-tail");
		const grown = snapshot("s-tail", 8, "a");
		expect(runTranscriptCommand(agent, grown)).toBe("saved");
		expect(stored(other, "s-tail")).toEqual(grown.records.map((each) => each.json));
		// The first five rows were kept as they were, not deleted and inserted again.
		expect(rowIds("s-tail").slice(0, 5)).toEqual(before);
		expect(transcripts.stamp(other.mirror.db, "s-tail")).toMatchObject({
			byte_size: grown.stamp.size,
			mtime: grown.stamp.mtime,
		});
	});

	it("replaces rows that differ, and drops stored rows past the new transcript's end", () => {
		expect(runTranscriptCommand(agent, snapshot("s-diff", 6, "a"))).toBe("saved");
		const shorter = snapshot("s-diff", 4, "b");
		expect(runTranscriptCommand(agent, shorter)).toBe("saved");
		expect(stored(other, "s-diff")).toEqual(shorter.records.map((each) => each.json));
	});

	it("saves a large difference in bounded steps; between them the copy is a prefix that never reads as level", () => {
		const old = snapshot("s-steps", 450, "a");
		expect(runTranscriptCommand(agent, old)).toBe("saved");
		const next = snapshot("s-steps", 500, "b");
		const oldLines = old.records.map((each) => each.json);
		const newLines = next.records.map((each) => each.json);
		const seen: number[] = [];
		const pause = () => {
			// Another connection can write now: the step released the lock.
			other.transaction(() => undefined);
			const rows = stored(other, "s-steps");
			seen.push(rows.length);
			const prefixOf = (lines: string[]) => rows.every((value, n) => value === lines[n]);
			expect(prefixOf(oldLines) || prefixOf(newLines)).toBe(true);
			const stamp = transcripts.stamp(other.mirror.db, "s-steps");
			expect(stamp?.mtime).not.toBe(next.stamp.mtime);
			expect(stamp?.mtime).not.toBe(old.stamp.mtime);
		};
		expect(runTranscriptCommand(agent, next, { pause })).toBe("saved");
		expect(seen.length).toBeGreaterThan(3);
		expect(stored(other, "s-steps")).toEqual(newLines);
		expect(transcripts.stamp(other.mirror.db, "s-steps")).toMatchObject({
			byte_size: next.stamp.size,
			mtime: next.stamp.mtime,
		});
	});

	it("bounds a step by bytes as well as rows", () => {
		expect(runTranscriptCommand(agent, snapshot("s-bytes", 150, "a", 20_000))).toBe("saved");
		let pauses = 0;
		const next = snapshot("s-bytes", 150, "b", 20_000);
		expect(runTranscriptCommand(agent, next, { pause: () => void pauses++ })).toBe("saved");
		// 150 rows of about 20 KB: about 3 MB in steps of at most 512 KB, after the deletes.
		expect(pauses).toBeGreaterThanOrEqual(5);
		expect(stored(other, "s-bytes")).toEqual(next.records.map((each) => each.json));
	});

	it("steps a save of few rows when they are large", () => {
		let pauses = 0;
		const first = snapshot("s-few", 20, "a", 100_000);
		expect(runTranscriptCommand(agent, first, { pause: () => void pauses++ })).toBe("saved");
		expect(pauses).toBeGreaterThanOrEqual(3);
		expect(stored(other, "s-few")).toEqual(first.records.map((each) => each.json));
	});

	it("stops when another writer saved the transcript between its steps", () => {
		expect(runTranscriptCommand(agent, snapshot("s-race", 450, "a"))).toBe("saved");
		const next = snapshot("s-race", 500, "b");
		let theirs: string[] = [];
		const pause = () => {
			if (theirs.length) return;
			const command = snapshot("s-race", 500, "c");
			theirs = command.records.map((each) => each.json);
			expect(runTranscriptCommand(other, command)).toBe("saved");
		};
		expect(runTranscriptCommand(agent, next, { pause })).toBe("current");
		expect(stored(other, "s-race")).toEqual(theirs);
	});

	it("stops when the transcript was removed between its steps", () => {
		expect(runTranscriptCommand(agent, snapshot("s-gone", 450, "a"))).toBe("saved");
		const next = snapshot("s-gone", 500, "b");
		const pause = () => other.mirror.transaction(() => transcripts.removeFile(other.mirror.db, next.file, "s-gone"));
		expect(runTranscriptCommand(agent, next, { pause })).toBe("skipped");
		expect(transcripts.stamp(other.mirror.db, "s-gone")).toBeUndefined();
		expect(stored(other, "s-gone")).toEqual([]);
	});

	it("appends a batch of entries with one stamp write", () => {
		const first = snapshot("s-batch", 2, "a");
		expect(runTranscriptCommand(agent, first)).toBe("saved");
		const added = [2, 3, 4].map((n) => line("s-batch", n, "a"));
		fs.appendFileSync(first.file, added.map((each) => `${each}\n`).join(""));
		const grown = { stamp: getFileStamp(first.file), records: [...first.records, ...added.map(row)] };
		const entries = grown.records.slice(2).map((record, n) => ({ position: n + 2, record }));
		const command: TranscriptCommand = {
			kind: "sync",
			sessionId: "s-batch",
			file: first.file,
			stamp: grown.stamp,
			previous: { size: first.stamp.size, mtime: first.stamp.mtime },
			header: header("s-batch"),
			entries,
			workspace,
		};
		expect(runTranscriptCommand(agent, command)).toBe("saved");
		expect(stored(other, "s-batch")).toEqual(grown.records.map((each) => each.json));
		expect(transcripts.stamp(other.mirror.db, "s-batch")).toMatchObject({ byte_size: grown.stamp.size });
	});
});
