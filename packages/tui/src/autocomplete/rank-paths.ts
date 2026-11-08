import { fuzzyMatchPath } from "../fuzzy.ts";
import type { IndexedPath } from "./file-index.ts";

const MAX_PATH_SUGGESTIONS = 50;

export interface RankedPath extends IndexedPath {
	/** Indexes into the path of the matched query characters (empty for an empty query). */
	positions: number[];
}

function compareTies(a: RankedPath, b: RankedPath): number {
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	if (a.path.length !== b.path.length) return a.path.length - b.path.length;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Best `limit` entries for `query`. An empty query lists the top level, directories first.
 * Otherwise entries are ordered by `fuzzyMatchPath` score, ties by directories, length, name.
 */
export function rankPaths(
	entries: readonly IndexedPath[],
	query: string,
	limit: number = MAX_PATH_SUGGESTIONS,
	onMatches?: (matches: RankedPath[]) => void,
): RankedPath[] {
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

	const scored: Array<RankedPath & { score: number }> = [];
	for (const entry of entries) {
		const match = fuzzyMatchPath(query, entry.path);
		if (match) scored.push({ ...entry, positions: match.positions, score: match.score });
	}
	// Every match, before ranking: a longer query can only match a subset, so callers may rank just these next time.
	onMatches?.(scored);
	scored.sort((a, b) => b.score - a.score || compareTies(a, b));
	return scored.slice(0, limit);
}

/** Matched indexes that fall inside the basename, shifted so they index a label that starts at the basename. */
export function basenameMatches(path: string, positions: number[]): number[] {
	const baseStart = path.lastIndexOf("/") + 1;
	return positions.filter((position) => position >= baseStart).map((position) => position - baseStart);
}
