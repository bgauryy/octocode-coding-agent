import fs from "node:fs";
import path from "node:path";
import { atomicWriteChunksSync, sha256, syncDirectorySync } from "../../common/src/atomic-file.ts";
import { withFileLockSync } from "../../common/src/file-write-lock.ts";
import { parseArchiveRecord, type ArchiveRecord } from "./history-record.ts";
import {
	ArchiveDamagedError,
	decodedLines,
	encodeMember,
	inflate,
	MEMBER_CHARS,
	MEMBER_MAX_BYTES,
	MEMBER_ROWS,
	memberHeads,
	readMemberBytes,
} from "./history-member.ts";

interface Pending {
	text: string;
	at: number;
}

const COPY_CHUNK = 1024 * 1024;

/** Closes full members as lines arrive, so the output is never held whole. */
class Members {
	rows = 0;
	private chunk: Buffer | undefined;
	private lines: string[] = [];
	private chars = 0;
	private minAt = Number.POSITIVE_INFINITY;
	private maxAt = Number.NEGATIVE_INFINITY;
	private readonly write: (chunk: Uint8Array) => void;
	constructor(write: (chunk: Uint8Array) => void) {
		this.write = write;
	}
	add(text: string, at: number): void {
		this.lines.push(text);
		this.chars += text.length;
		this.minAt = Math.min(this.minAt, at);
		this.maxAt = Math.max(this.maxAt, at);
		if (this.lines.length >= MEMBER_ROWS || this.chars >= MEMBER_CHARS) this.close();
	}
	copy(fd: number, offset: number, bytes: number, rows: number): void {
		this.chunk ??= Buffer.alloc(COPY_CHUNK);
		const buffer = this.chunk;
		for (let done = 0; done < bytes;) {
			const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - done), offset + done);
			if (length === 0) throw new Error("History archive copy came back short.");
			this.write(buffer.subarray(0, length));
			done += length;
		}
		this.rows += rows;
	}
	raw(bytes: Buffer, rows: number): void {
		this.write(bytes);
		this.rows += rows;
	}
	close(): void {
		if (this.lines.length === 0) return;
		this.write(encodeMember(this.lines, this.minAt, this.maxAt));
		this.rows += this.lines.length;
		this.lines = [];
		this.chars = 0;
		this.minAt = Number.POSITIVE_INFINITY;
		this.maxAt = Number.NEGATIVE_INFINITY;
	}
}

/**
 * Rewrites one month file with `records` merged in, holding its lock (several Octocode processes may archive at once):
 * one record per database and id, or per receipt snapshot for mutable commands (a stale archiver must not replace a
 * newer receipt). Identical retries are kept once; no record outlives the keep window. Written atomically and owner-only
 * (the rows are as private as the database); a month left empty is removed.
 *
 * The month is walked member by member (see `history-member.ts`): a member no change can touch is copied as raw bytes
 * and the rest are inflated one at a time, so memory is one member however large the month and nothing already
 * compressed is compressed again. New records go into new members after the existing ones; a small last member is
 * folded in so members stay near `MEMBER_ROWS` rows. A month without member headers is
 * refused as damaged and left as it was.
 */
export function rewriteMonth(
	file: string,
	records: readonly ArchiveRecord[],
	now: number,
	keepMs: number,
	assertActive: () => void,
): void {
	assertActive();
	withFileLockSync(
		file,
		(assertHeld) => {
			assertActive();
			const floor = now - keepMs;
			const audit = path.basename(file).startsWith("audits-");
			const receipts = path.basename(file).startsWith("workspace-commands-");
			// A line starts with its database and id, so its text up to `,"at":` names the pair without parsing the line.
			const base = (record: ArchiveRecord) => `{"db":${JSON.stringify(record.db)},"id":${JSON.stringify(record.id)}`;
			const key = (record: ArchiveRecord) =>
				receipts ? JSON.stringify([record.db, record.id, sha256(JSON.stringify(record.row))]) : base(record);
			const pending = new Map<string, Pending>();
			const bases = new Set<string>();
			for (const record of records) {
				if (record.at < floor) continue;
				pending.set(key(record), { text: JSON.stringify(record), at: record.at });
				bases.add(base(record));
			}
			let fd: number | undefined;
			try {
				fd = fs.openSync(file, "r");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const size = fd === undefined ? 0 : fs.fstatSync(fd).size;
			let changed = false;
			/** Set when a line of the member being read was dropped, so it cannot be copied as it is. */
			let dropped = false;

			/** Existing lines that survive: past the floor, not replaced by a pending record; identical retries are settled. */
			const survivors = (lines: Iterable<string>, keep: (text: string, at: number) => void): number => {
				let count = 0;
				for (const text of lines) {
					if (count++ % 1024 === 0) assertActive();
					const record = parseArchiveRecord(text, audit);
					if (record.at < floor) {
						dropped = true;
						changed = true;
						continue;
					}
					if (bases.has(base(record))) {
						const id = key(record);
						const incoming = pending.get(id);
						if (incoming) {
							if (JSON.stringify(record) === incoming.text) pending.delete(id);
							else {
								dropped = true;
								changed = true;
								continue;
							}
						}
					}
					keep(text, record.at);
				}
				return count;
			};

			/** Whether a line of `decoded` may be one a pending record replaces; a line not in the written shape counts. */
			const touches = (decoded: Buffer, head: { offset: number; rows: number }): boolean => {
				let count = 0;
				for (const text of decodedLines(decoded)) {
					count++;
					const end = text.indexOf(',"at":');
					if (end === -1 || !text.startsWith('{"db":') || bases.has(text.slice(0, end))) return true;
				}
				if (count !== head.rows)
					throw new ArchiveDamagedError(file, `member at byte ${head.offset} holds ${count} rows, not ${head.rows}`);
				return false;
			};

			const replace = (write: (chunk: Uint8Array) => void): boolean => {
				const members = new Members(write);
				if (fd !== undefined) {
					for (const head of memberHeads(fd, size, file)) {
						assertActive();
						if (head.maxAt < floor) {
							changed = true;
							continue;
						}
						const tail = head.offset + head.bytes === size;
						// A small last member is folded into the new ones when there is something to add.
						const fold = tail && pending.size > 0 && head.rows < MEMBER_ROWS / 2;
						if (!fold && pending.size === 0 && head.minAt >= floor) {
							members.copy(fd, head.offset, head.bytes, head.rows);
							continue;
						}
						const bytes = readMemberBytes(fd, head);
						const decoded = inflate(bytes, file, MEMBER_MAX_BYTES);
						// Members this build wrote were validated then and the gzip trailer vouches for them: with no
						// replacement in play and nothing expired, only the lines' ids are compared, not parsed.
						if (!fold && head.minAt >= floor && !touches(decoded, head)) {
							members.raw(bytes, head.rows);
							continue;
						}
						const kept: Array<[string, number]> = [];
						dropped = false;
						const count = survivors(decodedLines(decoded), (text, at) => kept.push([text, at]));
						if (count !== head.rows)
							throw new ArchiveDamagedError(
								file,
								`member at byte ${head.offset} holds ${count} rows, not ${head.rows}`,
							);
						if (!dropped && !fold) members.raw(bytes, head.rows);
						else for (const [text, at] of kept) members.add(text, at);
					}
				}
				for (const incoming of [...pending.values()].sort((a, b) => a.at - b.at))
					members.add(incoming.text, incoming.at);
				changed ||= pending.size > 0;
				if (!changed) return false;
				members.close();
				return members.rows > 0;
			};

			try {
				const committed = atomicWriteChunksSync(file, replace, {
					mode: 0o600,
					beforeCommit: () => {
						assertActive();
						assertHeld();
					},
				});
				if (committed) return;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
			assertHeld();
			assertActive();
			if (changed) {
				fs.rmSync(file, { force: true });
				return;
			}
			if (size === 0 && !fs.existsSync(file)) return;
			if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
			if (records.length) {
				// A prior writer may have stopped after rename but before flushing its directory entry.
				const handle = fs.openSync(file, "r");
				try {
					fs.fsyncSync(handle);
				} finally {
					fs.closeSync(handle);
				}
				syncDirectorySync(path.dirname(file));
			}
		},
		{ attempts: 1 },
	);
}
