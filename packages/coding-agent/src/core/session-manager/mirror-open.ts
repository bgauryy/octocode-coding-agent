import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { getFileStamp } from "../../../../common/src/paths.ts";
import { type FileStamp, transcripts } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { recordLines } from "./mirror-lines.ts";
import { mirrorWorkspace, row, sendContinuation, type Transcript } from "./mirror-writes.ts";
import { READER_LOCK_WAIT_MS, withSessionFileLock } from "./shared-file.ts";

/**
 * An opened file whose mirror is behind but holds a prefix of it (another process appended after the last save, or the
 * mirror missed the last writes): send only the lines past the stored stamp's size as an append, instead of reading,
 * parsing and sending the whole transcript. Used only when the stored stamp names this file and its identity, stops
 * below the file's size at a line end, and the file holds the last stored row there byte for byte. The writer adds the
 * rows only while the mirror is still level with that stamp; otherwise its `stale` reply rebuilds everything. False: the
 * caller rebuilds from the whole file, as before.
 */
export function continueOpenedMirror(t: Transcript, stamp: FileStamp): boolean {
	let end: ReturnType<typeof transcripts.storedEnd>;
	try {
		end = transcripts.storedEnd(sharedAgentDb().mirror.db, t.sessionId);
	} catch {
		return false;
	}
	const saved = end.stamp;
	const last = end.last;
	if (
		!saved ||
		!last ||
		end.header === undefined ||
		saved.file !== t.file ||
		saved.file_binding !== stamp.binding ||
		saved.byte_size >= stamp.size
	)
		return false;
	// The last stored row's line and its newline end exactly at the stored size.
	const lastLine = Buffer.from(`${last.json}\n`);
	const start = saved.byte_size - lastLine.length;
	if (start < 0) return false;
	// Large gaps are read and parsed by the database worker's snapshot command.
	if (stamp.size - start > 1024 * 1024) return false;
	let read: { stamp: FileStamp; bytes: Buffer } | undefined;
	try {
		read = withSessionFileLock(t.file, () => readFrom(t.file, start), READER_LOCK_WAIT_MS);
	} catch {
		return false;
	}
	if (!read || read.stamp.binding !== saved.file_binding || read.stamp.size <= saved.byte_size) return false;
	if (!read.bytes.subarray(0, lastLine.length).equals(lastLine)) return false;
	// Lines are records from the stored size on, as a whole-file read would find them.
	const { records, lines } = recordLines(read.bytes, lastLine.length);
	sendContinuation(t, "open", {
		kind: "sync",
		sessionId: t.sessionId,
		file: t.file,
		stamp: read.stamp,
		previous: { size: saved.byte_size, mtime: saved.mtime },
		header: end.header,
		entries: records.map((record, index) => ({
			position: end.stored + index,
			record: row(record as { id?: unknown; parentId?: unknown; type?: unknown }, lines[index]),
		})),
		workspace: mirrorWorkspace(t.cwd, false),
	});
	return true;
}

/** The file's bytes from `start` to its end and the stamp that describes them; undefined when it changed meanwhile. */
function readFrom(file: string, start: number): { stamp: FileStamp; bytes: Buffer } | undefined {
	const stamp = getFileStamp(file);
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (fstatSync(fd).size !== stamp.size) return undefined;
		const bytes = Buffer.allocUnsafe(stamp.size - start);
		let filled = 0;
		while (filled < bytes.length) {
			const count = readSync(fd, bytes, filled, bytes.length - filled, start + filled);
			if (count === 0) return undefined;
			filled += count;
		}
		return { stamp, bytes };
	} finally {
		closeSync(fd);
	}
}
