import type { FileScan, PassageHit } from "./analyze.ts";
import { type Query, termsOf, WORD } from "./terms.ts";

const K1 = 1.2;
const B = 0.75;
const PHRASE_BOOST = 1.5;
/** Added to a passage's multiplier when its file's label and header cover every query term (less for fewer). */
const HEADER_BOOST = 0.25;
/** Passages a search keeps and pages through. */
export const TOP = 100;

export interface RankedPassage extends PassageHit {
	/** Index of its file in the searched list. */
	file: number;
	score: number;
}

/**
 * What the first pass over every file gathers, however each file was read (the index or a scan): passages and words
 * in all, passages with each term, the matching passages, and for each file holding one, its header's query terms and
 * the stamp it was read at.
 */
export interface FirstPass {
	total: number;
	totalLength: number;
	df: number[];
	passages: RankedPassage[];
	files: Map<number, { headed: number; stamp: string }>;
}

export const firstPass = (query: Query): FirstPass => ({
	total: 0,
	totalLength: 0,
	df: Array.from({ length: query.terms.length }, () => 0),
	passages: [],
	files: new Map(),
});

/** Adds file `index` (labelled `label`, read at `stamp`) as `scan` counted it. */
export function addFile(pass: FirstPass, query: Query, index: number, label: string, stamp: string, scan: FileScan) {
	pass.total += scan.passages;
	pass.totalLength += scan.words;
	if (scan.hits.length === 0) return;
	const headed = new Set(scan.firstTerms);
	const wanted = new Set(query.terms);
	for (const [word] of label.matchAll(WORD)) for (const term of termsOf(word)) if (wanted.has(term)) headed.add(term);
	pass.files.set(index, { headed: headed.size, stamp });
	for (const hit of scan.hits) {
		for (let at = 0; at < hit.tf.length; at++) if (hit.tf[at] > 0) pass.df[at]++;
		pass.passages.push({ ...hit, file: index, score: 0 });
	}
}

/** A ranking: the best `TOP` passages, passages with each term, matching passages and files, each top file's stamp. */
export interface Scored {
	top: RankedPassage[];
	df: number[];
	hits: number;
	files: number;
	stamps: Map<number, string>;
}

/** BM25 of one passage (with the coverage, header and phrase boosts). */
function score(query: Query, pass: FirstPass, passage: RankedPassage, idf: number[], average: number): number {
	let total = 0;
	for (let at = 0; at < passage.tf.length; at++) {
		const tf = passage.tf[at];
		if (tf > 0) total += idf[at] * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * passage.length) / average)));
	}
	total *= 0.5 + (0.5 * passage.covered) / query.terms.length;
	total *= 1 + (HEADER_BOOST * (pass.files.get(passage.file)?.headed ?? 0)) / query.terms.length;
	return total * PHRASE_BOOST ** passage.phrases;
}

/**
 * Scores every passage. `confirm` (when given) counts the quoted phrases of the passages it is handed; it gets only
 * those whose score with every phrase could still reach the best `TOP`, since a phrase only multiplies a score.
 */
export function scorePassages(query: Query, pass: FirstPass, confirm?: (passages: RankedPassage[]) => void): Scored {
	const { total, df } = pass;
	const average = total > 0 ? pass.totalLength / total : 1;
	const idf = query.terms.map((_, at) => Math.log(1 + (total - df[at] + 0.5) / (df[at] + 0.5)));
	for (const passage of pass.passages) passage.score = score(query, pass, passage, idf, average);
	if (confirm && query.phrases.length > 0) {
		const scores = pass.passages.map((passage) => passage.score).sort((a, b) => b - a);
		const floor = scores[Math.min(TOP, scores.length) - 1] ?? 0;
		const most = PHRASE_BOOST ** query.phrases.length;
		const open = pass.passages.filter((passage) => passage.score * most >= floor);
		confirm(open);
		for (const passage of open) passage.score = score(query, pass, passage, idf, average);
	}
	const top = pass.passages.sort((a, b) => b.score - a.score || a.file - b.file || a.start - b.start).slice(0, TOP);
	const stamps = new Map(top.map((passage) => [passage.file, pass.files.get(passage.file)!.stamp]));
	return { top, df, hits: pass.passages.length, files: pass.files.size, stamps };
}
