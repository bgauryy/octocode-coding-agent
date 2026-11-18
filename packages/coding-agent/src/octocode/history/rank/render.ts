import fs, { constants } from "node:fs";
import { archiveRankedText, archiveRankedWindow } from "../archive/ranked.ts";
import { type HistoryFile, paginate } from "../transcripts.ts";
import { plural } from "../../shared/text.ts";
import type { RankedPassage, Scored } from "./score.ts";
import { TOP } from "./score.ts";
import { BOUNDARY, type Query, termsOf, WORD } from "./terms.ts";

/** Lines with a term shown per passage. */
const SHOWN_LINES = 8;
/** Characters of a shown line before it points to `file` and `line`. */
const LINE_CHARS = 400;

const lineLabel = (n: number, hit: boolean) => `${hit ? ">" : " "}${String(n).padStart(6)}│ `;

/** A file's identity for ranking: size, modification time and inode. */
export const fileStamp = (stat: { size: number; mtimeMs: number; ino: number }) =>
	`${stat.size}:${stat.mtimeMs}:${stat.ino}`;

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Lines of `file` with the stamp they were read at: the whole file, or only bytes `range` when the file is still at
 * `stamp`; undefined when it is gone, not a regular file or a link. Synchronous: a page reads up to `TOP` small ranges,
 * and four thread-pool round trips each took seconds in all on a loaded machine.
 */
function readLines(
	file: string,
	range?: { stamp: string; byteStart: number; byteEnd: number },
): { lines: string[]; stamp: string; ranged: boolean } | undefined {
	try {
		const fd = fs.openSync(file, OPEN_FLAGS);
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) return undefined;
			const stamp = fileStamp(stat);
			if (range && range.stamp === stamp) {
				const bytes = Buffer.alloc(Math.max(0, range.byteEnd - range.byteStart));
				const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, range.byteStart);
				return { lines: bytes.toString("utf8", 0, bytesRead).split("\n"), stamp, ranged: true };
			}
			return { lines: fs.readFileSync(fd, "utf8").split("\n"), stamp, ranged: false };
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) return undefined;
		throw error;
	}
}

function hasTerm(line: string, wanted: ReadonlySet<string>): boolean {
	for (const [word] of line.matchAll(WORD)) for (const term of termsOf(word)) if (wanted.has(term)) return true;
	return false;
}

/**
 * Up to `SHOWN_LINES` lines of `passage` with a query term, after its heading line when it starts at one; `lines` and
 * `ranked` begin at line `first` of the file.
 */
function shownLines(
	lines: readonly string[],
	ranked: readonly string[],
	first: number,
	passage: RankedPassage,
	wanted: ReadonlySet<string>,
): string[] {
	const shown: string[] = [];
	const at0 = passage.start - first;
	const last = Math.min(passage.end - first, lines.length - 1);
	if (at0 <= last && BOUNDARY.test(lines[at0]))
		shown.push(`${lineLabel(passage.start + 1, false)}${lines[at0].slice(0, LINE_CHARS)}`);
	for (let at = at0; at <= last && shown.length < SHOWN_LINES; at++) {
		if (!hasTerm(ranked[at] ?? "", wanted) || (at === at0 && shown.length > 0)) continue;
		const line = lines[at];
		const n = at + first + 1;
		shown.push(
			`${lineLabel(n, true)}${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}… [${line.length} characters: read it with file and line ${n}]` : line}`,
		);
	}
	return shown;
}

/** The lines shown under each of `top`, in its order: each read back by its byte range while its file is unchanged. */
function secondPass(
	files: readonly HistoryFile[],
	top: readonly RankedPassage[],
	stamps: ReadonlyMap<number, string>,
	wanted: ReadonlySet<string>,
	signal?: AbortSignal,
): string[][] {
	const whole = new Map<number, ReturnType<typeof readLines> | null>();
	const shown: string[][] = [];
	for (const passage of top) {
		signal?.throwIfAborted();
		const { file } = files[passage.file];
		const stamp = stamps.get(passage.file) ?? "";
		let read = whole.has(passage.file) ? undefined : readLines(file, { stamp, ...passage });
		if (read?.ranged) {
			const ranked = archiveRankedWindow(file, read.lines, passage.context);
			shown.push(shownLines(read.lines, ranked, passage.start, passage, wanted));
			continue;
		}
		// The file changed after it was ranked: shown from what it holds now, with a note.
		if (!whole.has(passage.file)) whole.set(passage.file, read ?? null);
		read = whole.get(passage.file) ?? undefined;
		const lines = read ? shownLines(read.lines, archiveRankedText(file, read.lines), 0, passage, wanted) : [];
		lines.push(
			read
				? "  (the file changed after it was ranked; read it again with file and line)"
				: "  (the file can no longer be read)",
		);
		shown.push(lines);
	}
	return shown;
}

export interface RankPages {
	pages: string[];
	total: number;
	hits: number;
	files: number;
}

/** The ranking's pages: a head naming counts per term, then each of `top` with its shown lines. */
export function renderRanking(
	files: readonly HistoryFile[],
	query: Query,
	scored: Scored,
	signal?: AbortSignal,
): RankPages {
	const { df, top, hits } = scored;
	const label = (term: string) => query.labels.get(term) ?? term;
	const termLine = query.terms.map((term, at) => `${label(term)} ${df[at]}`).join(" · ");
	const missing = query.terms.filter((_, at) => df[at] === 0).map(label);
	const matchedFiles = scored.files;
	const head = [
		`${plural(hits, "passage")} match in ${matchedFiles} of ${plural(files.length, "file")}${hits > TOP ? `; the best ${TOP} are ranked` : ""}, by BM25 relevance; > marks a line with a term. Read around one with file and line.`,
		`Passages per term: ${termLine}.${missing.length > 0 ? ` In none: ${missing.join(", ")}; try a synonym, another spelling or an identifier.` : ""}`,
	];
	const shown = secondPass(files, top, scored.stamps, new Set(query.terms), signal);
	const blocks = top.map((passage, rank) => {
		const { file, session, label: fileLabel } = files[passage.file];
		return {
			heading: `## ${rank + 1}. score ${passage.score.toFixed(2)} · ${file} · ${session.id} (${session.relation}) · ${fileLabel} · lines ${passage.start + 1}–${passage.end + 1}`,
			lines: shown[rank],
		};
	});
	const pages = paginate([{ lines: [...head, ""] }, ...blocks]);
	return { pages, total: hits === 0 ? 0 : pages.length, hits, files: matchedFiles };
}
