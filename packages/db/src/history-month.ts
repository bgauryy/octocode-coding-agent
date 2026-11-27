import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { parseArchiveRecord, type ArchiveRecord } from "./history-record.ts";

const FILE = /^(audits|config-audits|workspace-commands)-(\d{4})-(\d{2})\.jsonl\.gz$/;
const CACHE_BYTES = 4 * 1024 * 1024;
const CACHE_ROWS = 4096;
const CACHE_MONTHS = 32;
type Month = { file: string; start: number; end: number };
type Entry = { stamp: string; records: ArchiveRecord[]; bytes: number };
const cache = new Map<string, Entry>();
let cacheBytes = 0;
let cacheRows = 0;

/** Month names and UTC bounds; unrelated files are never read or removed. */
export function monthFiles(dir: string, family?: string): Month[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const match = FILE.exec(name);
		if (!match || (family && match[1] !== family)) return [];
		const start = Date.UTC(Number(match[2]), Number(match[3]) - 1, 1);
		const end = Date.UTC(Number(match[2]), Number(match[3]), 1);
		return [{ file: path.join(dir, name), start, end }];
	});
}

function forget(file: string): void {
	const old = cache.get(file);
	if (!old) return;
	cacheBytes -= old.bytes;
	cacheRows -= old.records.length;
	cache.delete(file);
}

/** Remove disappeared or expired months without evicting another archive directory's still-valid entries. */
export function pruneMonthCache(dir: string, files: string[]): void {
	const kept = new Set(files);
	for (const file of cache.keys()) if (path.dirname(file) === dir && !kept.has(file)) forget(file);
}

function stamp(file: string): string | undefined {
	const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
	return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined;
}

function hit(file: string, version: string | undefined): ArchiveRecord[] | undefined {
	const entry = cache.get(file);
	if (entry?.stamp !== version) {
		forget(file);
		return undefined;
	}
	if (!entry) return undefined;
	cache.delete(file);
	cache.set(file, entry);
	return entry.records;
}

function remember(file: string, version: string, records: ArchiveRecord[], bytes: number): void {
	forget(file);
	if (bytes > CACHE_BYTES || records.length > CACHE_ROWS) return;
	while (
		cache.size &&
		(cache.size >= CACHE_MONTHS || cacheBytes + bytes > CACHE_BYTES || cacheRows + records.length > CACHE_ROWS)
	)
		forget(cache.keys().next().value!);
	cache.set(file, { stamp: version, records, bytes });
	cacheBytes += bytes;
	cacheRows += records.length;
}

function load(file: string): { records: ArchiveRecord[]; bytes: number } {
	let data: Buffer;
	try {
		data = fs.readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], bytes: 0 };
		throw error;
	}
	const decoded = zlib.gunzipSync(data);
	return {
		records: decoded
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => parseArchiveRecord(line, path.basename(file).startsWith("audits-"))),
		bytes: decoded.length,
	};
}

/** Synchronous compatibility read; a missing month is empty, a damaged one throws; only small months fit the process-wide decoded-byte and row budgets. */
export function cachedMonth(file: string): ArchiveRecord[] {
	const version = stamp(file);
	const cached = hit(file, version);
	if (cached) return cached;
	if (!version) return [];
	const { records, bytes } = load(file);
	remember(file, version, records, bytes);
	return records;
}

/**
 * Visit a month without retaining it whole. Consumers stage their selection until the gzip trailer and every record
 * validate: a corrupt month contributes no partial rows. Only small complete months enter the bounded shared cache.
 */
export async function visitMonth(
	file: string,
	visit: (record: ArchiveRecord) => void,
	assertActive: () => void,
): Promise<void> {
	assertActive();
	const version = stamp(file);
	const cached = hit(file, version);
	if (cached) {
		for (const record of cached) {
			assertActive();
			visit(record);
		}
		return;
	}
	if (!version) return;
	let collected: ArchiveRecord[] | undefined = [];
	let bytes = 0;
	const decoder = new StringDecoder("utf8");
	let pending = "";
	const line = (text: string) => {
		if (!text) return;
		assertActive();
		const record = parseArchiveRecord(text, path.basename(file).startsWith("audits-"));
		visit(record);
		if (collected) {
			if (bytes > CACHE_BYTES || collected.length >= CACHE_ROWS) collected = undefined;
			else collected.push(record);
		}
	};
	await pipeline(fs.createReadStream(file), zlib.createGunzip(), async (source) => {
		for await (const chunk of source) {
			assertActive();
			bytes += (chunk as Buffer).length;
			pending += decoder.write(chunk as Buffer);
			let start = 0;
			for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n", start)) {
				line(pending.slice(start, end));
				start = end + 1;
			}
			pending = pending.slice(start);
		}
		line(pending + decoder.end());
	});
	assertActive();
	if (collected) remember(file, version, collected, bytes);
}
