import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, DbWriter, type DbWriterLocations, type TranscriptCommand } from "../src/api.ts";
import { getFileStamp } from "../../common/src/paths.ts";
import { tmp } from "./helpers.ts";

let dir: string;
let locations: DbWriterLocations;
let writers: DbWriter[];
let readers: DatabaseSync[];
beforeEach(() => {
	dir = tmp();
	locations = {
		file: path.join(dir, "writer.db"),
		mirrorFile: path.join(dir, "writer.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	writers = [];
	readers = [];
});
afterEach(() => {
	for (const reader of readers) if (reader.isOpen) reader.close();
	for (const writer of writers) writer.close();
	closeSharedAgentDb();
});

/** SQLite's own checkpoint threshold: what a WAL returns to, at most, once its writer is idle. */
const AUTOCHECKPOINT_PAGES = 1000;

/** Pages the WAL of `file` holds (its header is 32 bytes, each frame 24 plus a page). */
function walPages(file: string): number {
	const size = fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0;
	return size <= 32 ? 0 : Math.floor((size - 32) / (4096 + 24));
}

const workspace = { id: "ws-wal", root: "/r/wal", name: "wal", binding: "1:1" };
const PAD = "x".repeat(2000);

/** A session file with `count` padded entries and its save command, its stamp taken after the write. */
function save(id: string, count: number): TranscriptCommand {
	const header = { type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/r/wal" };
	const records = Array.from({ length: count }, (_, n) => ({
		type: "custom",
		id: `${id}-${n}`,
		parentId: n ? `${id}-${n - 1}` : null,
		pad: PAD,
	}));
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, [header, ...records].map((line) => `${JSON.stringify(line)}\n`).join(""));
	return {
		kind: "save",
		sessionId: id,
		file: fs.realpathSync(file),
		stamp: getFileStamp(file),
		header: JSON.stringify(header),
		records: records.map((record) => ({
			id: record.id,
			parentId: record.parentId,
			type: record.type,
			json: JSON.stringify(record),
		})),
		workspace,
	};
}

/** A connection that stays open the whole test, as another process's UI would. */
function longLivedReader(file: string): DatabaseSync {
	const reader = new DatabaseSync(file);
	readers.push(reader);
	return reader;
}

describe("the writer's checkpoints", () => {
	it("bring the mirror's WAL back to at most 1000 pages once idle, past a long-lived reader", async () => {
		const writer = new DbWriter(locations, { role: "mirror" });
		writers.push(writer);
		expect(await writer.submit(save("s-first", 1))).toBe("saved");
		const reader = longLivedReader(locations.mirrorFile);
		// The reader's snapshot pins the WAL: no checkpoint can pass it, so the file grows past SQLite's threshold.
		reader.exec("BEGIN");
		reader.prepare("SELECT COUNT(*) AS n FROM session_entries").get();
		for (let n = 0; n < 12; n++) expect(await writer.submit(save(`s-${n}`, 300))).toBe("saved");
		expect(walPages(locations.mirrorFile)).toBeGreaterThan(AUTOCHECKPOINT_PAGES);
		reader.exec("COMMIT");
		// The reader stays connected and keeps reading in short transactions while the writer is idle.
		const reading = setInterval(() => reader.prepare("SELECT COUNT(*) AS n FROM session_transcripts").get(), 25);
		try {
			await vi.waitFor(() => expect(walPages(locations.mirrorFile)).toBeLessThanOrEqual(AUTOCHECKPOINT_PAGES), {
				timeout: 20_000,
				interval: 100,
			});
		} finally {
			clearInterval(reading);
		}
		expect(reader.prepare("SELECT COUNT(*) AS n FROM session_transcripts").get()).toEqual({ n: 13 });
	});

	it("bring the coordination file's WAL back to at most 1000 pages once idle, past a long-lived reader", async () => {
		const writer = new DbWriter(locations);
		writers.push(writer);
		const title = (id: string) =>
			writer.post({
				kind: "session-title",
				id,
				title: PAD,
				source: "user",
				fileMtime: null,
				owner: { cwd: "/", file: "/f" },
			});
		const catalog = (id: string) =>
			writer.post({
				kind: "session-catalog",
				id,
				entry: {
					title: null,
					titleSource: null,
					cwd: "/r/wal",
					file: `/r/wal/${id}.jsonl`,
					parentFile: null,
					createdAt: 1,
					lastActive: 1,
					messageCount: 1,
					firstPrompt: PAD,
					fileMtime: null,
				},
			});
		await catalog("first");
		const reader = longLivedReader(locations.file);
		reader.exec("BEGIN");
		reader.prepare("SELECT COUNT(*) AS n FROM sessions").get();
		// In batches below the writer's queue limit.
		for (let batch = 0; batch < 15; batch++) {
			const ids = Array.from({ length: 100 }, (_, n) => `s-${batch * 100 + n}`);
			await Promise.all(ids.flatMap((id) => [catalog(id), title(id)]));
		}
		expect(walPages(locations.file)).toBeGreaterThan(AUTOCHECKPOINT_PAGES);
		reader.exec("COMMIT");
		const reading = setInterval(() => reader.prepare("SELECT COUNT(*) AS n FROM sessions").get(), 25);
		try {
			await vi.waitFor(() => expect(walPages(locations.file)).toBeLessThanOrEqual(AUTOCHECKPOINT_PAGES), {
				timeout: 20_000,
				interval: 100,
			});
		} finally {
			clearInterval(reading);
		}
		expect(reader.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1501 });
	});
});
