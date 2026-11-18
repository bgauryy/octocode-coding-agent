import fs from "node:fs";
import type { HistoryFile } from "./transcripts.ts";
import { scanHistory, type ScanPosition } from "./search.ts";
import { fileStamp, renderRanking, type RankPages } from "./rank/render.ts";
import { archiveIndexFallback, rankArchive } from "./index/client.ts";
import { parseKeywords } from "./rank/terms.ts";

export { parseKeywords, stem, wordTerms } from "./rank/terms.ts";

/**
 * Ranked search of history by keywords (Okapi BM25), for questions about a topic rather than an exact text. Each file is
 * cut into passages (a message, tool call or section, at most 40 lines); words are lowercased, lightly stemmed and
 * identifiers split (`loginRedirect`, `auth-storage/keychain.ts`, `B314` each match their parts), and a passage scores
 * by BM25 over the query terms, weighted by how many of them it covers and by quoted phrases it contains (`rank/`).
 * Each archive file counts only what the session said (`archiveRankedText`), not the wording its writer repeats in
 * every file of its kind; shown lines are the file's own. The first pass runs in the archive-index worker
 * (`index/client.ts`): files the index holds at their current stamp answer from FTS5, the rest are read once and only
 * the lines one test of the query's stems can match are tokenized; both keep each matching passage's counts and byte
 * range, so the second pass reads back only the bytes of the best `TOP` passages. A `query` filter runs
 * first, in the archive-search worker, in bounded scans that resume until every file is read. A file whose own label
 * (its TL;DR) or header has query terms ranks its passages higher, since a segment about the topic is likelier to hold
 * the answer. The last few rankings are kept in memory with the stamp of every file they read, so the next page of
 * the same search reads nothing again while those files are unchanged.
 */

export interface RankResult {
	text: string;
	page: number;
	pages: number;
	/** Passages with at least one term. */
	hits: number;
	files: number;
	/** Set when the ranking ran on the main thread because the index worker could not load. */
	degraded?: string;
}

/** Rankings kept for their next pages, most recent last. */
const KEPT_RANKINGS = 4;
const rankings = new Map<string, RankPages>();

/**
 * What a ranking depends on: the words, the filter, and each file with its stamp. Stats run in one synchronous loop
 * (tens of milliseconds for a whole archive); a thousand queued on the thread pool took a second under load.
 */
function rankingKey(files: readonly HistoryFile[], keywords: string, filter?: RegExp): string {
	const stamps = files.map(({ file, label }) => {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		return [file, label, stat ? fileStamp(stat) : ""];
	});
	return JSON.stringify([keywords, filter?.source ?? null, filter?.flags ?? null, stamps]);
}

/** Matching lines one filter scan collects before it resumes (a scan ends sooner at its time budget). */
const FILTER_SCAN_MATCHES = 200_000;

/**
 * The lines `filter` matches in each file, by file index. The expression comes from the model, so it runs where a query
 * search runs it: in the archive-search worker, which stops it after 5 seconds; each scan is bounded by matches and
 * time, and the next one resumes where it stopped, so the corpus size is no limit.
 */
async function filterMatches(
	files: readonly HistoryFile[],
	filter: RegExp,
	signal?: AbortSignal,
): Promise<Map<number, Set<number>>> {
	const paths = files.map(({ file }) => file);
	const found = new Map<number, Set<number>>();
	let start: ScanPosition | undefined;
	do {
		signal?.throwIfAborted();
		const scan = await scanHistory(paths, filter, signal, {
			...(start ? { start } : {}),
			maxMatches: FILTER_SCAN_MATCHES,
		});
		for (const { index, matched } of scan.results) {
			const lines = found.get(index) ?? new Set<number>();
			for (const line of matched) lines.add(line);
			found.set(index, lines);
		}
		start = scan.next;
	} while (start);
	return found;
}

/**
 * The passages of `files` that best match `keywords`, ranked by BM25, `TOP` at most, paged; `filter` (the `query` regex)
 * keeps passages with a line it matches (`filterMatches`). The head names each term's passage count, so a term found
 * nowhere is visible.
 */
export async function rankHistory(
	files: readonly HistoryFile[],
	keywords: string,
	page = 1,
	filter?: RegExp,
	signal?: AbortSignal,
): Promise<RankResult> {
	const query = parseKeywords(keywords);
	if (query.terms.length === 0) throw new Error("keywords needs at least one word or identifier.");
	// The next page of the same search over unchanged files is the ranking already made.
	const key = rankingKey(files, keywords, filter);
	let ranking = rankings.get(key);
	if (!ranking) {
		const filtered = filter ? await filterMatches(files, filter, signal) : undefined;
		const scored = await rankArchive(files, keywords, filtered, signal);
		ranking = renderRanking(files, query, scored, signal);
		rankings.delete(key);
		rankings.set(key, ranking);
		for (const old of rankings.keys()) if (rankings.size > KEPT_RANKINGS) rankings.delete(old);
	}
	const index = Math.min(Math.max(page, 1), ranking.pages.length);
	const failure = archiveIndexFallback();
	return {
		text: ranking.pages[index - 1] ?? "",
		page: index,
		pages: ranking.total,
		hits: ranking.hits,
		files: ranking.files,
		...(failure
			? { degraded: `The archive index worker could not load (${failure}); ranked on the main thread, slower.` }
			: {}),
	};
}
