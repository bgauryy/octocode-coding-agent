import fs, { constants } from "node:fs";
import { type ArchiveIndexDb, archiveIndex } from "../../../../../db/src/api.ts";
import { archiveRankedWindow, type RankedContext } from "../archive/ranked.ts";
import { scanQuery, type ScanQuery } from "../rank/analyze.ts";
import { type FirstPass, firstPass, type RankedPassage, type Scored, scorePassages } from "../rank/score.ts";
import { type Filtered, type RankFile, scanFiles } from "../rank/scan.ts";
import { matchesWithin } from "../rank/line-runs.ts";
import { parseKeywords, termsOf, WORD } from "../rank/terms.ts";
import { syncFiles } from "./sync.ts";

/**
 * A ranking from the archive index: files the index holds at their current stamp contribute their stored passage and
 * word totals and the passages FTS5 finds with a query term; the rest are scanned (`../rank/scan.ts`), so N and the
 * average length cover every file and the scores equal a scan's.
 */

/** Bytes of changed or new files a query indexes before ranking; past it they are scanned this time. */
const QUERY_SYNC_BYTES = 4 * 1024 * 1024;

/** Passages found in the index, by passage id there; their byte range and context load only when read back. */
type Unranged = Map<RankedPassage, number>;

/**
 * Gives each of `passages` still in `unranged` its byte range and context from the index. Returns those whose rows are
 * gone: another process re-indexed their file, so it changed since it was ranked.
 */
function loadRanges(index: ArchiveIndexDb, passages: readonly RankedPassage[], unranged: Unranged): RankedPassage[] {
	const wanted = new Map<number, RankedPassage>();
	for (const passage of passages) {
		const id = unranged.get(passage);
		if (id !== undefined) wanted.set(id, passage);
	}
	for (const range of archiveIndex.passageRanges(index.db, [...wanted.keys()])) {
		const passage = wanted.get(range.id)!;
		passage.byteStart = range.byteStart;
		passage.byteEnd = range.byteEnd;
		if (range.context) passage.context = JSON.parse(range.context) as RankedContext;
		unranged.delete(passage);
		wanted.delete(range.id);
	}
	return [...wanted.values()];
}

/** Counts the quoted phrases of each of `passages` in its ranked text, read back from its byte range. */
function confirmPhrases(files: readonly RankFile[], query: ScanQuery, passages: RankedPassage[]) {
	for (const passage of passages) {
		let fd: number;
		try {
			fd = fs.openSync(files[passage.file].file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			// Gone since it was indexed: the second pass says so.
			if ((error as NodeJS.ErrnoException).code) continue;
			throw error;
		}
		try {
			const bytes = Buffer.alloc(passage.byteEnd - passage.byteStart);
			const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, passage.byteStart);
			const lines = bytes.toString("utf8", 0, bytesRead).split("\n");
			const text = archiveRankedWindow(files[passage.file].file, lines, passage.context).join("\n").toLowerCase();
			passage.phrases = query.phrases.filter((phrase) => text.includes(phrase)).length;
		} finally {
			fs.closeSync(fd);
		}
	}
}

/**
 * Adds the indexed files' totals and the passages FTS5 holds with a query term to `pass`; returns them by passage id,
 * still without their byte range (`loadRanges`).
 */
function addIndexed(
	index: ArchiveIndexDb,
	pass: FirstPass,
	files: readonly RankFile[],
	query: ScanQuery,
	indexed: ReadonlyMap<number, { fileIndex: number; stamp: string; passages: number; words: number }>,
	filtered: Filtered | undefined,
): Unranged {
	for (const file of indexed.values()) {
		pass.total += file.passages;
		pass.totalLength += file.words;
	}
	const found = new Map<number, RankedPassage>();
	// Without indexed files there is nothing to read, so a file lacking the FTS tables is not queried.
	const rows = indexed.size === 0 ? [] : archiveIndex.termCounts(index.db, query.terms, [...indexed.keys()]);
	for (const [id, fileId, term, count, start, end, length] of rows) {
		const file = indexed.get(fileId);
		if (!file) continue;
		let passage = found.get(id);
		if (!passage) {
			passage = {
				file: file.fileIndex,
				start,
				end,
				byteStart: 0,
				byteEnd: 0,
				tf: Array.from({ length: query.terms.length }, () => 0),
				covered: 0,
				length,
				phrases: 0,
				score: 0,
			};
			found.set(id, passage);
		}
		const at = query.index.get(term)!;
		if (passage.tf[at] === 0) passage.covered++;
		passage.tf[at] += count;
	}
	// A file's header terms come from its first passage whether or not a filter keeps it.
	const headed = new Map<number, Set<string>>();
	const kept: Unranged = new Map();
	for (const [id, passage] of found) {
		if (passage.start === 0) {
			const terms = headed.get(passage.file) ?? new Set<string>();
			query.terms.forEach((term, at) => passage.tf[at] > 0 && terms.add(term));
			headed.set(passage.file, terms);
		}
		if (filtered && !matchesWithin(filtered.get(passage.file), passage.start, passage.end)) continue;
		kept.set(passage, id);
	}
	const stamps = new Map([...indexed.values()].map((file) => [file.fileIndex, file.stamp]));
	for (const passage of kept.keys()) {
		if (!pass.files.has(passage.file)) {
			const terms = headed.get(passage.file) ?? new Set<string>();
			for (const [word] of files[passage.file].label.matchAll(WORD))
				for (const term of termsOf(word)) if (query.wanted.has(term)) terms.add(term);
			pass.files.set(passage.file, { headed: terms.size, stamp: stamps.get(passage.file)! });
		}
		for (let at = 0; at < passage.tf.length; at++) if (passage.tf[at] > 0) pass.df[at]++;
		pass.passages.push(passage);
	}
	return kept;
}

/**
 * Ranks `files` for `keywords` with the index: changed files up to `QUERY_SYNC_BYTES` are indexed first, the others
 * not held at their current stamp are scanned. `check` runs between files and inside long ones (cancellation).
 */
export async function rankIndexed(
	index: ArchiveIndexDb,
	files: readonly RankFile[],
	keywords: string,
	filtered: Filtered | undefined,
	check: () => void | Promise<void>,
	syncBytes = QUERY_SYNC_BYTES,
	poll?: () => void,
): Promise<Scored> {
	const query = scanQuery(parseKeywords(keywords));
	if (query.terms.length === 0) throw new Error("keywords needs at least one word or identifier.");
	const pass = firstPass(query);
	const indexed = new Map<number, { fileIndex: number; stamp: string; passages: number; words: number }>();
	const scanned: number[] = [];
	// The flag is read at open; the tables may have been dropped since, so a ranking checks them again and scans if gone.
	if (index.fts && archiveIndex.hasFts(index.db)) {
		const { current } = await syncFiles(
			index,
			files.map(({ file }) => file),
			check,
			syncBytes,
			poll,
		);
		files.forEach(({ file }, fileIndex) => {
			const held = current.get(file);
			// A file listed twice is counted once from the index and scanned again, as a scan would count it.
			if (held && !indexed.has(held.id)) indexed.set(held.id, { fileIndex, ...held });
			else scanned.push(fileIndex);
		});
	} else scanned.push(...files.keys());
	const unranged = addIndexed(index, pass, files, query, indexed, filtered);
	const fromIndex = new Set(unranged.keys());
	await scanFiles(pass, files, query, filtered, check, scanned);
	const scored = scorePassages(query, pass, (open) => {
		const held = open.filter((passage) => fromIndex.has(passage));
		const gone = new Set(loadRanges(index, held, unranged));
		return confirmPhrases(
			files,
			query,
			held.filter((passage) => !gone.has(passage)),
		);
	});
	// A passage whose file was re-indexed meanwhile is shown from the file as it is now, marked changed.
	for (const passage of loadRanges(index, scored.top, unranged)) scored.stamps.set(passage.file, "");
	return scored;
}
