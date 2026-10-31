import { clip, plural } from "../../../../coding-agent/src/octocode/shared/render/text.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** Longest error sentence shown in the row; the full payload shows when the row expands. */
const ERROR_CHARS = 200;
/** An error longer than this drops its trailing parenthetical (a long allow-list), kept in the expanded payload. */
const ERROR_SHORT_CHARS = 160;
/** Array fields of a result that name what it lists, most telling first. */
const LISTS = ["repositories", "pullRequests", "commits", "artifacts", "symbols", "nodes", "matches", "files"] as const;

/** Cut at a word boundary: `…` marks the cut. */
function clipWords(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function errorSentence(message: string): string {
	const text = clip(message, Number.MAX_SAFE_INTEGER);
	const paren = text.indexOf(" (");
	const short = text.length > ERROR_SHORT_CHARS && paren >= 12 ? text.slice(0, paren) : text;
	return clipWords(short, ERROR_CHARS);
}

/** `lines 1–5 of 76` from a numbered file read (`12\tcode`), or the line count when the lines carry no numbers. */
function readRange(data: Record<string, unknown>, content: string): string {
	const rows = content.split("\n");
	while (rows.length > 1 && rows.at(-1) === "") rows.pop();
	const first = /^(\d+)\t/.exec(rows[0] ?? "")?.[1];
	const last = /^(\d+)\t/.exec(rows.at(-1) ?? "")?.[1];
	const total = typeof data.totalLines === "number" ? data.totalLines : undefined;
	if (!first || !last) return plural(rows.length, "line");
	return `lines ${first === last ? first : `${first}–${last}`}${total === undefined ? "" : ` of ${total}`}`;
}

function countOf(data: Record<string, unknown>, key: string): number | undefined {
	const list = data[key];
	if (!Array.isArray(list)) return undefined;
	const items = isRecord(data.pagination) ? data.pagination.totalItems : undefined;
	return typeof items === "number" ? items : list.length;
}

/** One query's outcome as a short phrase; undefined when its shape is not known. */
function describe(data: Record<string, unknown>): string | undefined {
	const path = typeof data.path === "string" ? data.path : "";
	const lead = (text: string) => (path ? `${path} · ${text}` : text);
	if (typeof data.content === "string") return lead(readRange(data, data.content));
	if (typeof data.matchCount === "number") {
		const files = Array.isArray(data.files) ? data.files.length : undefined;
		return lead(
			data.matchCount === 0
				? "no matches"
				: `${plural(data.matchCount, "match", "matches")}${files === undefined ? "" : ` in ${plural(files, "file")}`}`,
		);
	}
	if (isRecord(data.summary) && typeof data.summary.files === "number") {
		const dirs = typeof data.summary.dirs === "number" ? `, ${plural(data.summary.dirs, "dir")}` : "";
		return lead(`${plural(data.summary.files, "file")}${dirs}`);
	}
	for (const key of LISTS) {
		const count = countOf(data, key);
		if (count !== undefined) return lead(count === 0 ? `no ${key}` : `${count} ${key}`);
	}
	return path || undefined;
}

/**
 * What an Octocode research result says, in one line: the `data.error` sentence of a failed query, or the file and lines
 * read, the match and file counts, the number of items found. Undefined when the text is not the server's
 * `{"results":[{"index":0,"data":{…}}]}` envelope, so the caller shows the text as it is.
 */
export function summarizeResult(text: string): string | undefined {
	if (!text.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.results) || parsed.results.length === 0) return undefined;
	const parts: string[] = [];
	for (const result of parsed.results) {
		const data = isRecord(result) && isRecord(result.data) ? result.data : undefined;
		if (!data) return undefined;
		const message = typeof data.error === "string" && data.error.trim() ? errorSentence(data.error) : undefined;
		const part = message ?? describe(data);
		if (!part) return undefined;
		parts.push(part);
	}
	return clip(parts.length === 1 ? parts[0] : `${parts.length} queries · ${parts.join(" · ")}`, 400);
}
