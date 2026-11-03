import fs from "node:fs/promises";
import { constants } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { archiveRankedText } from "./archive/ranked.ts";
import type { HistoryFile } from "./history.ts";
import { paginate } from "./history.ts";
import { matchHistory } from "./history-search.ts";
import { plural } from "./render/text.ts";

/**
 * Ranked search of history by keywords (Okapi BM25), for questions about a topic rather than an exact text. Each file is
 * cut into passages (a message, tool call or section, at most `PASSAGE_LINES` lines); words are lowercased, lightly
 * stemmed and identifiers split (`loginRedirect`, `auth-storage/keychain.ts`, `B314` each match their parts), and a
 * passage scores by BM25 over the query terms, weighted by how many of them it covers and by quoted phrases it contains.
 * Each archive file counts only what the session said (`archiveRankedText`), not the wording its writer repeats in
 * every file of its kind; shown lines are the file's own. Files are read one at a time, yielding between them, and only
 * matching passages are kept, so no size cap applies; a `query` filter is the exception, since it runs in the
 * archive-search worker, which reads at most 32 MiB.
 */

const K1 = 1.2;
const B = 0.75;
const PASSAGE_LINES = 40;
/** Passages a search keeps and pages through. */
const TOP = 100;
/** Lines with a term shown per passage. */
const SHOWN_LINES = 8;
/** Characters of a shown line before it points to `file` and `line`. */
const LINE_CHARS = 400;
const PHRASE_BOOST = 1.5;
const WORD = /[\p{L}\p{N}]+(?:[._\-/][\p{L}\p{N}]+)*/gu;
const BOUNDARY = /^(?:#{1,4} |Tool `)/;
const STOPWORDS = new Set(
	"a an and are as at be by did do does for from how i in is it of on or our that the this to was we were what when where which who why with you".split(
		" ",
	),
);

/** The shared root of a word's inflections: failing, failed and fails are `fail`; queries is `query`; caches is `cach`. */
export function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && (w.endsWith("ed") || w.endsWith("es"))) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
	return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** The terms one word stands for: itself and, for an identifier or path, each part, all stemmed and lowercased. */
export function wordTerms(word: string): string[] {
	const whole = stem(word.toLowerCase());
	if (!/[._\-/]|.\p{Lu}/u.test(word)) return [whole];
	const parts = word
		.split(/[._\-/]+/)
		.flatMap((part) => part.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u))
		.filter(Boolean)
		.map((part) => stem(part.toLowerCase()));
	return [...new Set([whole, ...parts])];
}

interface Query {
	terms: string[];
	/** Lowercased quoted phrases. */
	phrases: string[];
	/** Each term as it was typed (lowercased), for messages: a stem such as `kerbero` would read as a typo. */
	labels: Map<string, string>;
}

/** `keywords` as query terms (stopwords dropped unless nothing else is left) and its quoted phrases. */
export function parseKeywords(keywords: string): Query {
	const phrases = [...keywords.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim().toLowerCase()).filter(Boolean);
	const words = keywords.match(WORD) ?? [];
	const kept = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
	const chosen = kept.length > 0 ? kept : words;
	const terms = [...new Set(chosen.flatMap(wordTerms))];
	const labels = new Map<string, string>();
	for (const word of chosen) {
		const parts = word.split(/[._\-/]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).filter(Boolean);
		for (const typed of [word, ...parts]) {
			const term = stem(typed.toLowerCase());
			if (!labels.has(term)) labels.set(term, typed.toLowerCase());
		}
	}
	return { terms, phrases, labels };
}

interface Passage {
	file: number;
	/** 0-based first and last line. */
	start: number;
	end: number;
	tf: Map<string, number>;
	length: number;
	score: number;
}

export interface RankResult {
	text: string;
	page: number;
	pages: number;
	/** Passages with at least one term. */
	hits: number;
	files: number;
}

const lineLabel = (n: number, hit: boolean) => `${hit ? ">" : " "}${String(n).padStart(6)}│ `;

function count(line: string, wanted: ReadonlySet<string>, tf?: Map<string, number>): number {
	let words = 0;
	for (const [word] of line.matchAll(WORD)) {
		words++;
		if (!tf) continue;
		for (const term of wordTerms(word)) if (wanted.has(term)) tf.set(term, (tf.get(term) ?? 0) + 1);
	}
	return words;
}

/**
 * The lines `filter` matches in each file, by file index. The expression comes from the model, so it runs where a query
 * search runs it: in the archive-search worker, which stops it after 5 seconds and reads at most 32 MiB.
 */
async function filterMatches(
	files: readonly HistoryFile[],
	filter: RegExp,
	signal?: AbortSignal,
): Promise<Map<number, ReadonlySet<number>>> {
	const matches = await matchHistory(
		files.map(({ file }) => file),
		filter,
		signal,
	);
	return new Map(matches.map(({ index, matched }) => [index, new Set(matched)]));
}

function matchesWithin(matched: ReadonlySet<number> | undefined, start: number, end: number): boolean {
	if (!matched) return false;
	for (let at = start; at <= end; at++) if (matched.has(at)) return true;
	return false;
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
	const wanted = new Set(query.terms);
	const df = new Map<string, number>(query.terms.map((term) => [term, 0]));
	const passages: Passage[] = [];
	/** Each kept file's lines as read and as counted (`archiveRankedText`), by file index. */
	const texts = new Map<number, { lines: string[]; ranked: readonly string[] }>();
	const filtered = filter ? await filterMatches(files, filter, signal) : undefined;
	let total = 0;
	let totalLength = 0;
	for (let index = 0; index < files.length; index++) {
		signal?.throwIfAborted();
		let lines: string[];
		try {
			const handle = await fs.open(files[index].file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				if (!(await handle.stat()).isFile()) continue;
				lines = (await handle.readFile("utf8")).split("\n");
			} finally {
				await handle.close();
			}
		} catch {
			continue;
		}
		const ranked = archiveRankedText(files[index].file, lines);
		let kept = false;
		for (let start = 0; start < lines.length;) {
			let end = start;
			while (end + 1 < lines.length && end + 1 - start < PASSAGE_LINES && !BOUNDARY.test(lines[end + 1])) end++;
			const tf = new Map<string, number>();
			let length = 0;
			for (let at = start; at <= end; at++) length += count(ranked[at], wanted, tf);
			total++;
			totalLength += length;
			if (tf.size > 0 && (!filtered || matchesWithin(filtered.get(index), start, end))) {
				for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
				passages.push({ file: index, start, end, tf, length, score: 0 });
				kept = true;
			}
			start = end + 1;
		}
		if (kept) texts.set(index, { lines, ranked });
		await yieldTurn();
	}
	const average = total > 0 ? totalLength / total : 1;
	const idf = new Map(
		query.terms.map((term) => {
			const n = df.get(term) ?? 0;
			return [term, Math.log(1 + (total - n + 0.5) / (n + 0.5))];
		}),
	);
	for (const passage of passages) {
		let score = 0;
		for (const [term, tf] of passage.tf)
			score += (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * passage.length) / average)));
		score *= 0.5 + (0.5 * passage.tf.size) / query.terms.length;
		if (query.phrases.length > 0) {
			const text = texts
				.get(passage.file)!
				.ranked.slice(passage.start, passage.end + 1)
				.join("\n")
				.toLowerCase();
			for (const phrase of query.phrases) if (text.includes(phrase)) score *= PHRASE_BOOST;
		}
		passage.score = score;
	}
	const top = passages.sort((a, b) => b.score - a.score || a.file - b.file || a.start - b.start).slice(0, TOP);
	const label = (term: string) => query.labels.get(term) ?? term;
	const termLine = query.terms.map((term) => `${label(term)} ${df.get(term) ?? 0}`).join(" · ");
	const missing = query.terms.filter((term) => !df.get(term)).map(label);
	const head = [
		`${plural(passages.length, "passage")} match in ${new Set(passages.map((p) => p.file)).size} of ${plural(files.length, "file")}${passages.length > TOP ? `; the best ${TOP} are ranked` : ""}, by BM25 relevance; > marks a line with a term. Read around one with file and line.`,
		`Passages per term: ${termLine}.${missing.length > 0 ? ` In none: ${missing.join(", ")}; try a synonym, another spelling or an identifier.` : ""}`,
	];
	const blocks = top.map((passage, rank) => {
		const { file, session, label } = files[passage.file];
		const { lines, ranked } = texts.get(passage.file)!;
		const shown: string[] = [];
		if (BOUNDARY.test(lines[passage.start]))
			shown.push(`${lineLabel(passage.start + 1, false)}${lines[passage.start].slice(0, LINE_CHARS)}`);
		for (let at = passage.start; at <= passage.end && shown.length < SHOWN_LINES; at++) {
			const tf = new Map<string, number>();
			count(ranked[at], wanted, tf);
			if (tf.size === 0 || (at === passage.start && shown.length > 0)) continue;
			const line = lines[at];
			shown.push(
				`${lineLabel(at + 1, true)}${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}… [${line.length} characters: read it with file and line ${at + 1}]` : line}`,
			);
		}
		return {
			heading: `## ${rank + 1}. score ${passage.score.toFixed(2)} · ${file} · ${session.id} (${session.relation}) · ${label} · lines ${passage.start + 1}–${passage.end + 1}`,
			lines: shown,
		};
	});
	const pages = paginate([{ lines: [...head, ""] }, ...blocks]);
	const index = Math.min(Math.max(page, 1), pages.length);
	return {
		text: pages[index - 1] ?? "",
		page: index,
		pages: passages.length === 0 ? 0 : pages.length,
		hits: passages.length,
		files: new Set(passages.map((p) => p.file)).size,
	};
}
