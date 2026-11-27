import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fuzzyMatchPath } from "../fuzzy.ts";
import type { IndexedPath } from "./file-index.ts";

const MAX_PATH_SUGGESTIONS = 50;
/** Entries scored between two yields: typed keys wait at most one chunk, not the whole index. */
export const RANK_CHUNK_SIZE = 1024;

export interface RankedPath extends IndexedPath {
	/** Indexes into the path of the matched query characters (empty for an empty query). */
	positions: number[];
}

export interface RankPathsOptions {
	limit?: number;
	/** Stops ranking between chunks; an aborted ranking returns no paths and reports no matches. */
	signal?: AbortSignal;
	/** Every entry that matched, before ranking: a longer query can only match a subset, so callers may rank just these next time. */
	onMatches?: (matches: IndexedPath[]) => void;
}

type ScoredPath = RankedPath & { score: number };

/** Best first: higher score, then directories, shorter paths, then by name. */
function compareRanked(a: ScoredPath, b: ScoredPath): number {
	if (a.score !== b.score) return b.score - a.score;
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	if (a.path.length !== b.path.length) return a.path.length - b.path.length;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Keep the best `limit` paths in order; an entry that ties the last kept one stays out, as a stable sort would leave it. */
function insertTop(top: ScoredPath[], candidate: ScoredPath, limit: number): void {
	if (top.length === limit && compareRanked(candidate, top[limit - 1]) >= 0) return;
	let low = 0;
	let high = top.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (compareRanked(candidate, top[middle]) < 0) high = middle;
		else low = middle + 1;
	}
	top.splice(low, 0, candidate);
	if (top.length > limit) top.pop();
}

/** Lowercased paths, remembered per entry so a keystroke does not lowercase the whole index again. */
const lowercasePaths = new WeakMap<IndexedPath, string>();

function lowercasePath(entry: IndexedPath): string {
	let lower = lowercasePaths.get(entry);
	if (lower === undefined) {
		lower = entry.path.toLowerCase();
		lowercasePaths.set(entry, lower);
	}
	return lower;
}

/** The query's characters appear in order: the same subsequence test `fuzzyMatchPath` starts with, without lowercasing the path each time. */
function containsSubsequence(text: string, query: string): boolean {
	if (query.length > text.length) return false;
	let from = 0;
	for (let i = 0; i < query.length; i++) {
		const at = text.indexOf(query[i], from);
		if (at === -1) return false;
		from = at + 1;
	}
	return true;
}

/**
 * Best `limit` entries for `query`. An empty query lists the top level, directories first.
 * Otherwise entries are ordered by `fuzzyMatchPath` score, ties by directories, length, name.
 * Scoring runs in chunks that yield to the event loop, so a large index never holds typed keys.
 */
export async function rankPaths(
	entries: readonly IndexedPath[],
	query: string,
	options: RankPathsOptions = {},
): Promise<RankedPath[]> {
	const { limit = MAX_PATH_SUGGESTIONS, signal, onMatches } = options;
	if (query === "") {
		return entries
			.filter((entry) => !entry.path.includes("/"))
			.map((entry) => ({ ...entry, positions: [] }))
			.sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
				return a.path.localeCompare(b.path);
			})
			.slice(0, limit);
	}

	// Smart case, as in `fuzzyMatchPath`: an uppercase letter makes the query case-sensitive.
	const caseSensitive = query !== query.toLowerCase();
	const top: ScoredPath[] = [];
	const matched: IndexedPath[] = [];
	for (let start = 0; start < entries.length; start += RANK_CHUNK_SIZE) {
		if (start > 0) await yieldToEventLoop();
		if (signal?.aborted) return [];
		const end = Math.min(entries.length, start + RANK_CHUNK_SIZE);
		for (let index = start; index < end; index++) {
			const entry = entries[index];
			if (!containsSubsequence(caseSensitive ? entry.path : lowercasePath(entry), query)) continue;
			const match = fuzzyMatchPath(query, entry.path);
			if (!match) continue;
			matched.push(entry);
			if (limit > 0) insertTop(top, { ...entry, positions: match.positions, score: match.score }, limit);
		}
	}
	if (signal?.aborted) return [];
	onMatches?.(matched);
	return top;
}

/** Matched indexes that fall inside the basename, shifted so they index a label that starts at the basename. */
export function basenameMatches(path: string, positions: number[]): number[] {
	const baseStart = path.lastIndexOf("/") + 1;
	return positions.filter((position) => position >= baseStart).map((position) => position - baseStart);
}
