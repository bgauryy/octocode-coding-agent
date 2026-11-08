/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}

		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		while (queryIndex < normalizedQuery.length) {
			const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
			if (i === -1) break;

			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);

			// Reward consecutive matches
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				// Penalize gaps
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			// Reward word boundary matches
			if (isWordBoundary) {
				score -= 10;
			}

			// Slight penalty for later matches
			score += i * 0.1;

			lastMatchIndex = i;
			queryIndex++;
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}

		if (normalizedQuery === textLower) {
			score -= 100;
		}

		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}

export interface PathMatch {
	/** Higher is better (the opposite of `fuzzyMatch`). */
	score: number;
	/** Indexes into the path of each matched query character, ascending. */
	positions: number[];
}

const SEGMENT_START_BONUS = 8;
const BOUNDARY_BONUS = 6;
const CAMEL_BONUS = 5;
const CONSECUTIVE_BONUS = 6;
const BASENAME_CHAR_BONUS = 3;
const BASENAME_ALL_BONUS = 12;
const GAP_START_PENALTY = 3;
const GAP_EXTEND_PENALTY = 1;
const NO_SCORE = Number.NEGATIVE_INFINITY;

function charBonus(path: string, index: number): number {
	if (index === 0) return SEGMENT_START_BONUS;
	const prev = path[index - 1];
	if (prev === "/") return SEGMENT_START_BONUS;
	if (prev === "." || prev === "-" || prev === "_" || prev === " ") return BOUNDARY_BONUS;
	const current = path[index];
	if (current !== current.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()) {
		return CAMEL_BONUS;
	}
	return 0;
}

/**
 * Best alignment of `query` as a subsequence of `path`, or null when it is not one.
 * Rewards basename hits, segment starts, camelCase humps, `.`/`-`/`_` boundaries and consecutive runs;
 * penalizes gaps, depth and length. A `/` in the query only matches a `/`, and the characters between two slashes cannot span path segments.
 * Smart case: matching is case-sensitive only when the query has an uppercase letter.
 */
export function fuzzyMatchPath(query: string, path: string): PathMatch | null {
	const m = query.length;
	const n = path.length;
	if (m === 0) return { score: 0, positions: [] };
	if (m > n) return null;

	const caseSensitive = query !== query.toLowerCase();
	const q = caseSensitive ? query : query.toLowerCase();
	const text = caseSensitive ? path : path.toLowerCase();

	// Cheap subsequence check before the quadratic alignment.
	let from = 0;
	for (let i = 0; i < m; i++) {
		const at = text.indexOf(q[i], from);
		if (at === -1) return null;
		from = at + 1;
	}

	const baseStart = path.lastIndexOf("/") + 1;
	const h = new Float64Array(m * n).fill(NO_SCORE);
	const prev = new Int32Array(m * n).fill(-1);
	for (let i = 0; i < m; i++) {
		const sameSegment = i > 0 && q[i] !== "/" && q[i - 1] !== "/";
		let runScore = NO_SCORE; // best earlier row-(i-1) cell, already penalized for the gap up to column j
		let runFrom = -1;
		for (let j = 0; j < n; j++) {
			if (i > 0 && j >= 2) {
				if (sameSegment && text[j - 1] === "/") {
					// Characters of one query segment cannot skip over a path separator.
					runScore = NO_SCORE;
					runFrom = -1;
				} else {
					runScore -= GAP_EXTEND_PENALTY;
					const gapped = h[(i - 1) * n + j - 2] - GAP_START_PENALTY;
					if (gapped > runScore) {
						runScore = gapped;
						runFrom = j - 2;
					}
				}
			}
			if (text[j] !== q[i]) continue;
			const own = charBonus(path, j) + (j >= baseStart ? BASENAME_CHAR_BONUS : 0);
			if (i === 0) {
				h[j] = own;
				continue;
			}
			let best = runScore;
			let bestFrom = runFrom;
			if (j >= 1) {
				const consecutive = h[(i - 1) * n + j - 1] + CONSECUTIVE_BONUS;
				if (consecutive > best) {
					best = consecutive;
					bestFrom = j - 1;
				}
			}
			if (best === NO_SCORE) continue;
			h[i * n + j] = best + own;
			prev[i * n + j] = bestFrom;
		}
	}

	let end = -1;
	let score = NO_SCORE;
	for (let j = 0; j < n; j++) {
		const value = h[(m - 1) * n + j];
		if (value > score) {
			score = value;
			end = j;
		}
	}
	if (end === -1) return null;

	const positions: number[] = Array.from({ length: m }, () => 0);
	let column = end;
	for (let i = m - 1; i >= 0; i--) {
		positions[i] = column;
		column = prev[i * n + column];
	}

	if (positions[0] >= baseStart) score += BASENAME_ALL_BONUS;
	let depth = 0;
	for (let i = 0; i < baseStart; i++) if (path[i] === "/") depth++;
	score -= depth * 0.5 + n * 0.05;
	return { score, positions };
}
