import { type AgentDb, memories, type ScopeFilter } from "../../../../db/src/api.ts";
import { DAY_MS } from "../shared/util.ts";
import { ftsQuery, MAX_QUERY_TERMS, stem, terms } from "./query.ts";
import { type Memory, type MemoryHit, toMemory } from "./record.ts";

/** Ranked memory search for the store: BM25 through FTS5 when the database has it, an IDF-weighted scan otherwise. */

/** A project hit ranks this much above an equally good global one. */
const PROJECT_BOOST = 1.15;
/** Rows the LIKE fallback scores in memory (newest first); far more than a person keeps. */
const LIKE_SCAN_LIMIT = 2000;
/** A memory nobody used for this long ranks lower in a search; nothing expires, and a pinned one stays where it is. */
const UNUSED_DAYS = 90;
const UNUSED_DISCOUNT = 0.75;
const unusedForLong = (memory: Memory, now: number): boolean =>
	!memory.pinned && now - (memory.lastUsed ?? memory.updatedAt) > UNUSED_DAYS * DAY_MS;

/**
 * Best matches for the words of `query`, best first. With FTS5: BM25 over title, keywords and body (weighted 5/3/1).
 * Without it: the same column weights times each term's inverse document frequency. Project hits get a small boost either way.
 */
export function searchMemories(
	agentDb: AgentDb,
	context: memories.MemoryContext,
	query: string,
	options: { scope: ScopeFilter; limit: number; exclude: ReadonlySet<number>; now: number },
): MemoryHit[] {
	const match = ftsQuery(query);
	if (!match) return [];
	const { scope, limit, exclude, now } = options;
	const hits = agentDb.fts
		? memories
				.searchFts(agentDb.db, context, match, scope, exclude, limit * 3)
				// bm25() is lower-is-better and negative for matches; negate so every score reads higher-is-better.
				.map((row) => ({ ...toMemory(row), score: -Number(row.bm25_score) }))
		: searchLike(agentDb, context, [...new Set(terms(query, MAX_QUERY_TERMS).map(stem))], scope);
	return hits
		.filter((hit) => !exclude.has(hit.id))
		.map((hit) => (hit.scope !== "global" ? { ...hit, score: hit.score * PROJECT_BOOST } : hit))
		.map((hit) => (unusedForLong(hit, now) ? { ...hit, score: hit.score * UNUSED_DISCOUNT } : hit))
		.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
		.slice(0, limit);
}

/** One page of ranked matches from the full-text index for the `memory` tool; undefined when the database has none. */
export function searchMemoryPage(
	agentDb: AgentDb,
	context: memories.MemoryContext,
	query: string,
	page: { scope: ScopeFilter; offset: number; limit: number },
): MemoryHit[] | undefined {
	if (!agentDb.fts) return undefined;
	const match = ftsQuery(query);
	if (!match) return [];
	return memories
		.searchFts(agentDb.db, context, match, page.scope, new Set(), page.limit, page.offset)
		.map((row) => ({ ...toMemory(row), score: -Number(row.bm25_score) }));
}

/** BM25-like without FTS5: per-column weights (5/3/1) times each term's inverse document frequency; `words` are stems. */
function searchLike(
	agentDb: AgentDb,
	context: memories.MemoryContext,
	words: string[],
	scope: ScopeFilter,
): MemoryHit[] {
	const docs = memories.newest(agentDb.db, context, scope, LIKE_SCAN_LIMIT).map((row) => {
		const memory = toMemory(row);
		const stems = (text: string) => new Set(terms(text).map(stem));
		return { memory, title: stems(memory.title), keywords: stems(memory.keywords), body: stems(memory.body) };
	});
	const idf = new Map(
		words.map((word) => {
			const df = docs.filter((doc) => doc.title.has(word) || doc.keywords.has(word) || doc.body.has(word)).length;
			return [word, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
		}),
	);
	return docs.flatMap((doc) => {
		const score = words.reduce(
			(sum, word) =>
				sum +
				idf.get(word)! *
					((doc.title.has(word) ? 5 : 0) + (doc.keywords.has(word) ? 3 : 0) + (doc.body.has(word) ? 1 : 0)),
			0,
		);
		return score > 0 ? [{ ...doc.memory, score }] : [];
	});
}
