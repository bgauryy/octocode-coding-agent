/**
 * The keyword ranking as it was before the passage prefilter and the archive index: every passage tokenized, every file
 * read whole twice. Tests require the current ranking to produce the same text.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { archiveRankedText } from "../../src/octocode/history/archive/ranked.ts";
import type { HistoryFile } from "../../src/octocode/history/transcripts.ts";
import { paginate } from "../../src/octocode/history/transcripts.ts";
import { scanHistory, type ScanPosition } from "../../src/octocode/history/search.ts";
import { plural } from "../../src/octocode/shared/text.ts";

/**
 * Ranked search of history by keywords (Okapi BM25), for questions about a topic rather than an exact text. Each file is
 * cut into passages (a message, tool call or section, at most `PASSAGE_LINES` lines); words are lowercased, lightly
 * stemmed and identifiers split (`loginRedirect`, `auth-storage/keychain.ts`, `B314` each match their parts), and a
 * passage scores by BM25 over the query terms, weighted by how many of them it covers and by quoted phrases it contains.
 * Each archive file counts only what the session said (`archiveRankedText`), not the wording its writer repeats in
 * every file of its kind; shown lines are the file's own. Files are read one at a time, yielding between them and
 * checking for cancellation inside a long file. The first pass keeps only each matching passage's counts (no file text),
 * and the second reads again only the files holding the best `TOP` passages to show their lines, so memory grows with the
 * number of matching passages, not with the size of the history; a `query` filter runs first, in the archive-search
 * worker, in bounded scans that resume until every file is read. A file whose own label (its TL;DR) or header (its TL;DR and topics
 * lines) has query terms ranks its passages higher, since a segment about the topic is likelier to hold the answer.
 * The last few rankings are kept in memory with the size and time of every file they read, so the next page of the same
 * search reads nothing again while those files are unchanged.
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
/** Added to a passage's multiplier when its file's label and header cover every query term (less for fewer). */
const HEADER_BOOST = 0.25;
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
	/** Occurrences of each query term, by its index in `Query.terms`. */
	tf: Uint32Array;
	/** Query terms with a nonzero count. */
	covered: number;
	length: number;
	/** Quoted phrases the passage contains. */
	phrases: number;
	score: number;
}

/** Passages scanned in one file between cancellation checks and yields. */
const PASSAGES_PER_TURN = 256;

/** `file` read as lines, or undefined when it is gone, not a regular file or a link; `stamp` is its size and mtime. */
async function readLines(file: string): Promise<{ lines: string[]; stamp: string } | undefined> {
	try {
		const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) return undefined;
			return { lines: (await handle.readFile("utf8")).split("\n"), stamp: `${stat.size}:${stat.mtimeMs}` };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
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

function matchesWithin(matched: ReadonlySet<number> | undefined, start: number, end: number): boolean {
	if (!matched) return false;
	for (let at = start; at <= end; at++) if (matched.has(at)) return true;
	return false;
}

/** Up to `SHOWN_LINES` lines of `passage` with a query term, after its heading line when it starts at one. */
function shownLines(
	lines: readonly string[],
	ranked: readonly string[],
	passage: Passage,
	wanted: ReadonlySet<string>,
): string[] {
	const shown: string[] = [];
	const last = Math.min(passage.end, lines.length - 1);
	if (passage.start <= last && BOUNDARY.test(lines[passage.start]))
		shown.push(`${lineLabel(passage.start + 1, false)}${lines[passage.start].slice(0, LINE_CHARS)}`);
	for (let at = passage.start; at <= last && shown.length < SHOWN_LINES; at++) {
		const tf = new Map<string, number>();
		count(ranked[at] ?? "", wanted, tf);
		if (tf.size === 0 || (at === passage.start && shown.length > 0)) continue;
		const line = lines[at];
		shown.push(
			`${lineLabel(at + 1, true)}${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}… [${line.length} characters: read it with file and line ${at + 1}]` : line}`,
		);
	}
	return shown;
}

/**
 * The passages of `files` that best match `keywords`, ranked by BM25, `TOP` at most, paged; `filter` (the `query` regex)
 * keeps passages with a line it matches (`filterMatches`). The head names each term's passage count, so a term found
 * nowhere is visible.
 */
export async function referenceRank(
	files: readonly HistoryFile[],
	keywords: string,
	page = 1,
	filter?: RegExp,
	signal?: AbortSignal,
): Promise<RankResult> {
	const query = parseKeywords(keywords);
	if (query.terms.length === 0) throw new Error("keywords needs at least one word or identifier.");
	// The next page of the same search over unchanged files is the ranking already made.
	const known = undefined as undefined | { pages: string[]; total: number; hits: number; files: number };
	if (known) {
		const index = Math.min(Math.max(page, 1), known.pages.length);
		return {
			text: known.pages[index - 1] ?? "",
			page: index,
			pages: known.total,
			hits: known.hits,
			files: known.files,
		};
	}
	const wanted = new Set(query.terms);
	const termIndex = new Map(query.terms.map((term, index) => [term, index]));
	const df = new Uint32Array(query.terms.length);
	const passages: Passage[] = [];
	/** The query terms each kept file's label and header carry, and the stamp it was ranked at, by file index. */
	const kept = new Map<number, { headed: number; stamp: string }>();
	const filtered = filter ? await filterMatches(files, filter, signal) : undefined;
	let total = 0;
	let totalLength = 0;
	for (let index = 0; index < files.length; index++) {
		signal?.throwIfAborted();
		const read = await readLines(files[index].file);
		if (!read) continue;
		const { lines } = read;
		const ranked = archiveRankedText(files[index].file, lines);
		let matched = false;
		const headTerms = new Set<string>();
		for (const word of files[index].label.match(WORD) ?? [])
			for (const term of wordTerms(word)) if (wanted.has(term)) headTerms.add(term);
		for (let start = 0, scanned = 0; start < lines.length; scanned++) {
			if (scanned > 0 && scanned % PASSAGES_PER_TURN === 0) {
				signal?.throwIfAborted();
				await yieldTurn();
			}
			let end = start;
			while (end + 1 < lines.length && end + 1 - start < PASSAGE_LINES && !BOUNDARY.test(lines[end + 1])) end++;
			const counts = new Map<string, number>();
			let length = 0;
			for (let at = start; at <= end; at++) length += count(ranked[at], wanted, counts);
			total++;
			totalLength += length;
			if (start === 0) for (const term of counts.keys()) headTerms.add(term);
			if (counts.size > 0 && (!filtered || matchesWithin(filtered.get(index), start, end))) {
				const tf = new Uint32Array(query.terms.length);
				for (const [term, n] of counts) {
					const at = termIndex.get(term)!;
					tf[at] = n;
					df[at]++;
				}
				let phrases = 0;
				if (query.phrases.length > 0) {
					const text = ranked
						.slice(start, end + 1)
						.join("\n")
						.toLowerCase();
					for (const phrase of query.phrases) if (text.includes(phrase)) phrases++;
				}
				passages.push({ file: index, start, end, tf, covered: counts.size, length, phrases, score: 0 });
				matched = true;
			}
			start = end + 1;
		}
		if (matched) kept.set(index, { headed: headTerms.size, stamp: read.stamp });
		await yieldTurn();
	}
	const average = total > 0 ? totalLength / total : 1;
	const idf = query.terms.map((_, at) => Math.log(1 + (total - df[at] + 0.5) / (df[at] + 0.5)));
	for (const passage of passages) {
		let score = 0;
		for (let at = 0; at < passage.tf.length; at++) {
			const tf = passage.tf[at];
			if (tf > 0) score += idf[at] * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * passage.length) / average)));
		}
		score *= 0.5 + (0.5 * passage.covered) / query.terms.length;
		score *= 1 + (HEADER_BOOST * (kept.get(passage.file)?.headed ?? 0)) / query.terms.length;
		score *= PHRASE_BOOST ** passage.phrases;
		passage.score = score;
	}
	const top = passages.sort((a, b) => b.score - a.score || a.file - b.file || a.start - b.start).slice(0, TOP);
	const label = (term: string) => query.labels.get(term) ?? term;
	const termLine = query.terms.map((term, at) => `${label(term)} ${df[at]}`).join(" · ");
	const missing = query.terms.filter((_, at) => df[at] === 0).map(label);
	const matchedFiles = new Set(passages.map((p) => p.file)).size;
	const head = [
		`${plural(passages.length, "passage")} match in ${matchedFiles} of ${plural(files.length, "file")}${passages.length > TOP ? `; the best ${TOP} are ranked` : ""}, by BM25 relevance; > marks a line with a term. Read around one with file and line.`,
		`Passages per term: ${termLine}.${missing.length > 0 ? ` In none: ${missing.join(", ")}; try a synonym, another spelling or an identifier.` : ""}`,
	];
	// Second pass: only the files holding a shown passage are read again, one at a time.
	const shownByFile = new Map<number, string[][]>();
	for (const fileIndex of new Set(top.map((passage) => passage.file))) {
		signal?.throwIfAborted();
		const read = await readLines(files[fileIndex].file);
		const changed = !read || read.stamp !== kept.get(fileIndex)?.stamp;
		const ranked = read ? archiveRankedText(files[fileIndex].file, read.lines) : [];
		for (const passage of top) {
			if (passage.file !== fileIndex) continue;
			const shown = read ? shownLines(read.lines, ranked, passage, wanted) : [];
			if (changed)
				shown.push(
					read
						? "  (the file changed after it was ranked; read it again with file and line)"
						: "  (the file can no longer be read)",
				);
			const list = shownByFile.get(fileIndex) ?? [];
			list.push(shown);
			shownByFile.set(fileIndex, list);
		}
		await yieldTurn();
	}
	const taken = new Map<number, number>();
	const blocks = top.map((passage, rank) => {
		const { file, session, label } = files[passage.file];
		const at = taken.get(passage.file) ?? 0;
		taken.set(passage.file, at + 1);
		return {
			heading: `## ${rank + 1}. score ${passage.score.toFixed(2)} · ${file} · ${session.id} (${session.relation}) · ${label} · lines ${passage.start + 1}–${passage.end + 1}`,
			lines: shownByFile.get(passage.file)?.[at] ?? [],
		};
	});
	const pages = paginate([{ lines: [...head, ""] }, ...blocks]);
	const index = Math.min(Math.max(page, 1), pages.length);
	const ranking = {
		pages,
		total: passages.length === 0 ? 0 : pages.length,
		hits: passages.length,
		files: matchedFiles,
	};
	return { text: pages[index - 1] ?? "", page: index, pages: ranking.total, hits: ranking.hits, files: ranking.files };
}
