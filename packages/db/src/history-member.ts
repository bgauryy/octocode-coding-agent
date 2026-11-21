import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Month file layout: a concatenation of gzip members, which any gzip reader reads as one stream. Each member written by
 * this build holds up to `MEMBER_ROWS` JSONL records and carries an `OA` extra field in its gzip header (RFC 1952 FEXTRA)
 * with its own byte length, row count and `at` range, so a writer steps over members and skips the ones a change cannot
 * touch without inflating them. A month without those headers (not written by this build) is refused as damaged.
 */
export const MEMBER_ROWS = 5000;
/** Decoded characters after which a member is closed even below `MEMBER_ROWS` (rows may be large). */
export const MEMBER_CHARS = 4 * 1024 * 1024;
/** Largest decoded size a member (or one inflated pass) may have; a larger one is refused as damaged. */
export const MEMBER_MAX_BYTES = 64 * 1024 * 1024;

const GZIP_HEADER = 10;
const FEXTRA = 4;
const SUBFIELD = 24;
const EXTRA = 4 + SUBFIELD;
const HEAD = GZIP_HEADER + 2 + EXTRA;

/** Where one member sits in a month file and what it holds. */
export interface MemberHead {
	offset: number;
	bytes: number;
	rows: number;
	minAt: number;
	maxAt: number;
}

export class ArchiveDamagedError extends Error {
	constructor(file: string, detail: string) {
		super(`History archive ${file} is damaged (${detail}); it was not changed.`);
		this.name = "ArchiveDamagedError";
	}
}

/** One gzip member of `lines` (JSONL), its header extended with the `OA` field. */
export function encodeMember(lines: readonly string[], minAt: number, maxAt: number): Buffer {
	const gz = zlib.gzipSync(`${lines.join("\n")}\n`);
	const head = Buffer.alloc(HEAD);
	gz.copy(head, 0, 0, GZIP_HEADER);
	head[3] |= FEXTRA;
	head.writeUInt16LE(EXTRA, GZIP_HEADER);
	head.write("OA", GZIP_HEADER + 2, "latin1");
	head.writeUInt16LE(SUBFIELD, GZIP_HEADER + 4);
	const fields = GZIP_HEADER + 6;
	head.writeUInt32LE(HEAD + gz.length - GZIP_HEADER, fields);
	head.writeUInt32LE(lines.length, fields + 4);
	head.writeDoubleLE(minAt, fields + 8);
	head.writeDoubleLE(maxAt, fields + 16);
	return Buffer.concat([head, gz.subarray(GZIP_HEADER)]);
}

/** The head of the member at `offset`, or undefined when it has no `OA` field (not written by this build, or not gzip at all). */
function readHead(fd: number, offset: number, size: number): MemberHead | undefined {
	const buffer = Buffer.alloc(HEAD);
	if (fs.readSync(fd, buffer, 0, Math.min(HEAD, size - offset), offset) < HEAD) return undefined;
	if (
		buffer[0] !== 0x1f ||
		buffer[1] !== 0x8b ||
		buffer[2] !== 8 ||
		buffer[3] !== FEXTRA ||
		buffer.readUInt16LE(GZIP_HEADER) !== EXTRA ||
		buffer.toString("latin1", GZIP_HEADER + 2, GZIP_HEADER + 4) !== "OA" ||
		buffer.readUInt16LE(GZIP_HEADER + 4) !== SUBFIELD
	)
		return undefined;
	const fields = GZIP_HEADER + 6;
	return {
		offset,
		bytes: buffer.readUInt32LE(fields),
		rows: buffer.readUInt32LE(fields + 4),
		minAt: buffer.readDoubleLE(fields + 8),
		maxAt: buffer.readDoubleLE(fields + 16),
	};
}

/** Every member head of the file; a torn or foreign member throws. */
export function* memberHeads(fd: number, size: number, file: string): Generator<MemberHead> {
	for (let offset = 0; offset < size;) {
		const head = readHead(fd, offset, size);
		if (!head) throw new ArchiveDamagedError(file, `no member header at byte ${offset}`);
		if (head.bytes <= HEAD || offset + head.bytes > size)
			throw new ArchiveDamagedError(file, `member at byte ${offset} is cut short`);
		yield head;
		offset += head.bytes;
	}
}

/** The compressed bytes of `head`. */
export function readMemberBytes(fd: number, head: MemberHead): Buffer {
	const bytes = Buffer.alloc(head.bytes);
	if (fs.readSync(fd, bytes, 0, head.bytes, head.offset) !== head.bytes)
		throw new Error("History archive member read came back short.");
	return bytes;
}

/** The decoded text of one member; a damaged or oversized one throws. */
export function inflate(bytes: Buffer, file: string, limit: number): Buffer {
	try {
		return zlib.gunzipSync(bytes, { maxOutputLength: limit });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
			throw new ArchiveDamagedError(file, "member too large");
		throw error;
	}
}

/** The non-empty lines of decoded JSONL, as text. */
export function* decodedLines(decoded: Buffer): Generator<string> {
	let start = 0;
	for (let end = decoded.indexOf(10); start < decoded.length; end = decoded.indexOf(10, start)) {
		const stop = end === -1 ? decoded.length : end;
		if (stop > start) yield decoded.toString("utf8", start, stop);
		start = stop + 1;
	}
}
