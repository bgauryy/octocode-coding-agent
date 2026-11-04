import fs from "node:fs";
import path from "node:path";
import { resolveToolPath } from "./home.ts";
import { canonicalPath } from "./home/repo.ts";
import { sha256, sha256File } from "../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { currentToolRoles } from "../../../../mcp/src/roles.ts";

/**
 * The reader contract: any MCP tool an entry declares as a `reader` or `search` role (`currentToolRoles`, trusted entries
 * only) can credit reads of workspace files to the file guard. Nothing here knows a server's result shape: a result is
 * credited only where its text equals the file on disk, unchanged since the call began.
 * - Before the call, every string under a key named `path` in the input (depth 6 or less) is snapshotted; a search role
 *   also snapshots directories, as the time its search began.
 * - After it, the result's structured content (or its one JSON text block) is walked. A string whose non-empty lines
 *   are all `N<TAB>text` (`--` separates groups) shows lines of the nearest enclosing object's `path` (resolved against
 *   the nearest absolute `root` or `base`, else cwd; with no such object, the input's only path). A line counts when its
 *   text is line N of the file. A string whose SHA-256 is the file's is a whole read.
 */

interface LocalRead {
	file: string;
	sha256: string;
	size: number;
	whole: boolean;
	lines?: readonly [number, number];
}

/** Add copyable source identities to the model's visible result, without changing the server's structured data. */
export function appendReadDigests<T extends { type: string }>(
	content: readonly T[],
	reads: readonly LocalRead[],
	options: { nested?: boolean; truncated?: boolean } = {},
): Array<T | { type: "text"; text: string }> {
	if (options.nested || options.truncated || !content.some((part) => part.type === "text")) return [...content];
	const sources = new Map<string, string>();
	for (const read of reads) {
		if (read.whole && path.isAbsolute(read.file) && /^[a-f0-9]{64}$/.test(read.sha256))
			sources.set(read.file, read.sha256);
	}
	if (!sources.size) return [...content];
	const lines = [...sources].map(([file, digest]) => `sourceSha256=${digest} path=${JSON.stringify(file)}`);
	return [...content, { type: "text", text: `Whole-source SHA-256 for optional anchored edits:\n${lines.join("\n")}` }];
}

/** A file's identity before retrieval; a searched directory has no file identity, only `searchedAt`, when the search began. */
type Snapshot = { sha256: string; size: number; mtimeMs: number; ctimeMs: number; searchedAt?: number };

/** Every credit is checked against the whole file; a larger file is not credited. */
const CREDIT_MAX_BYTES = 2 * 1024 * 1024;
/** How deep in the input `path` keys are looked for. */
const INPUT_PATH_DEPTH = 6;
/** How deep a result is walked; deeper values are not credited. */
const RESULT_DEPTH = 64;
const NUMBERED = /^(\d+)\t([\s\S]*)$/;

/**
 * Whether a tool is a reader or search role of the session's MCP entries (`roles` in their config, never server hints):
 * a project entry's roles count only in a trusted project, so an untrusted server cannot make its output a workspace read.
 */
export function isWorkspaceReader(tool: string): boolean {
	const roles = currentToolRoles();
	return roles.readers.has(tool) || roles.searches.has(tool);
}

/** Keys that name where a reader looks: `path`, `root`, `cwd`, `dir`, `directory`, or a name ending in one (`workspaceRoot`). */
const LOCATION_KEY = /^(?:path|root|cwd|dir|directory)$|(?:Path|Root|Cwd|Dir|Directory)$/;
/** Keys that explain a call rather than act. */
const EXPLANATION_KEYS = new Set(["reason", "reasoning", "mainGoal"]);

function locations(value: unknown, depth = 0, out: string[] = []): string[] {
	if (depth > INPUT_PATH_DEPTH) return out;
	if (Array.isArray(value)) for (const item of value) locations(item, depth + 1, out);
	else if (isRecord(value))
		for (const [key, item] of Object.entries(value)) {
			if (LOCATION_KEY.test(key) && typeof item === "string" && item !== "") out.push(item);
			else if (!EXPLANATION_KEYS.has(key)) locations(item, depth + 1, out);
		}
	return out;
}

/**
 * Every location a reader's input names (for read trust), and whether a request in it names none. Input naming no
 * location at its top level is a batch: each object in its top-level arrays is a request, and one naming no location may
 * read wherever the server chooses.
 */
export function readerLocations(input: Record<string, unknown>): { files: string[]; unnamed: boolean } {
	const named = (value: unknown, key: string) => LOCATION_KEY.test(key) && typeof value === "string" && value !== "";
	const topLevel = Object.entries(input).some(([key, value]) => named(value, key));
	const unnamed =
		!topLevel &&
		Object.values(input).some(
			(value) => Array.isArray(value) && value.some((item) => isRecord(item) && locations(item).length === 0),
		);
	return { files: locations(input), unnamed };
}

/** Every non-empty string under a key named `path`, at depth `INPUT_PATH_DEPTH` or less. */
function inputPaths(value: unknown, depth = 0, out: string[] = []): string[] {
	if (depth > INPUT_PATH_DEPTH) return out;
	if (Array.isArray(value)) for (const item of value) inputPaths(item, depth + 1, out);
	else if (isRecord(value))
		for (const [key, item] of Object.entries(value)) {
			if (key === "path" && typeof item === "string") {
				if (item !== "") out.push(item);
			} else inputPaths(item, depth + 1, out);
		}
	return out;
}

/** Capture requested files before retrieval so a changed file cannot be credited as the returned version. */
export async function snapshotLocalReads(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<Map<string, Snapshot>> {
	const snapshots = new Map<string, Snapshot>();
	const search = currentToolRoles().searches.has(tool);
	if (!isWorkspaceReader(tool)) return snapshots;
	for (const raw of new Set(inputPaths(input))) {
		const file = canonicalPath(resolveToolPath(cwd, raw));
		try {
			const stat = fs.statSync(file);
			if (stat.isDirectory()) {
				if (search) snapshots.set(file, { sha256: "", size: 0, mtimeMs: 0, ctimeMs: 0, searchedAt: Date.now() });
				continue;
			}
			if (!stat.isFile() || stat.size > CREDIT_MAX_BYTES) continue;
			const digest = await sha256File(file);
			snapshots.set(file, { sha256: digest, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
		} catch {
			/* Retrieval reports unreadable paths. */
		}
	}
	return snapshots;
}

/** A result's data: its structured content, else its one text block parsed as JSON; nothing for an error. */
function resultData(output: unknown): unknown {
	if (!isRecord(output) || output.isError === true) return undefined;
	if (output.structuredContent !== undefined) return output.structuredContent;
	const blocks = output.content;
	if (!Array.isArray(blocks) || blocks.length !== 1) return undefined;
	const [block] = blocks as unknown[];
	if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
	try {
		return JSON.parse(block.text) as unknown;
	} catch {
		return undefined;
	}
}

/** `[n, text]` of each line of a numbered string, or undefined when any non-empty, non-`--` line is not numbered. */
function numberedLines(value: string): Array<[number, string]> | undefined {
	const shown: Array<[number, string]> = [];
	for (const line of value.split("\n")) {
		if (line === "" || line === "--") continue;
		const match = NUMBERED.exec(line);
		if (!match) return undefined;
		shown.push([Number(match[1]), match[2]]);
	}
	return shown.length ? shown : undefined;
}

interface Shown {
	lines: Map<string, Array<[number, string]>>;
	texts: Map<string, string[]>;
}

function entries<T>(map: Map<string, T[]>, file: string): T[] {
	let list = map.get(file);
	if (!list) map.set(file, (list = []));
	return list;
}

/** Collects, by the file each belongs to, the numbered lines and the strings a result shows. */
function collect(value: unknown, file: string | undefined, base: string, depth: number, shown: Shown): void {
	if (depth > RESULT_DEPTH) return;
	if (typeof value === "string") {
		if (file === undefined) return;
		const numbered = numberedLines(value);
		if (numbered) entries(shown.lines, file).push(...numbered);
		else entries(shown.texts, file).push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collect(item, file, base, depth + 1, shown);
		return;
	}
	if (!isRecord(value)) return;
	const root = [value.root, value.base].find((item) => typeof item === "string" && path.isAbsolute(item));
	const nextBase = typeof root === "string" ? root : base;
	const named = typeof value.path === "string" && value.path !== "" ? value.path : undefined;
	const nextFile =
		named === undefined
			? file
			: canonicalPath(path.isAbsolute(named) ? named : resolveToolPath(nextBase, named));
	for (const [key, item] of Object.entries(value))
		if (key !== "path" && key !== "root" && key !== "base") collect(item, nextFile, nextBase, depth + 1, shown);
}

/** Credit only text that equals the file on disk, from files unchanged throughout retrieval. */
export async function completedLocalReads(
	snapshots: Map<string, Snapshot>,
	output: unknown,
	cwd: string,
	input?: unknown,
): Promise<LocalRead[]> {
	if (!snapshots.size) return [];
	const data = resultData(output);
	if (data === undefined) return [];
	const requested = [...new Set(inputPaths(input))];
	const only = requested.length === 1 ? canonicalPath(resolveToolPath(cwd, requested[0])) : undefined;
	const shown: Shown = { lines: new Map(), texts: new Map() };
	collect(data, only, cwd, 0, shown);
	const reads: LocalRead[] = [];
	for (const file of new Set([...shown.lines.keys(), ...shown.texts.keys()])) {
		const source = unchangedSource(file, snapshots);
		if (!source) continue;
		const base = { file, sha256: source.sha256, size: source.size };
		const texts = (shown.texts.get(file) ?? []).filter((text) => Buffer.byteLength(text) === source.size);
		if (texts.some((text) => sha256(Buffer.from(text)) === source.sha256)) {
			reads.push({ ...base, whole: true });
			continue;
		}
		const count = source.lines.at(-1) === "" ? source.lines.length - 1 : source.lines.length;
		const credited = new Set<number>();
		for (const [number, text] of shown.lines.get(file) ?? [])
			if (number >= 1 && number <= count && source.lines[number - 1] === text) credited.add(number);
		const spans: Array<[number, number]> = [];
		for (const line of [...credited].sort((a, b) => a - b)) {
			const last = spans.at(-1);
			if (last && line === last[1] + 1) last[1] = line;
			else spans.push([line, line]);
		}
		if (spans.length === 1 && spans[0][0] === 1 && spans[0][1] === count) reads.push({ ...base, whole: true });
		else for (const lines of spans) reads.push({ ...base, whole: false, lines });
	}
	return reads;
}

/** The file's lines when it is unchanged since its snapshot (or, in a searched directory, since before the search began). */
function unchangedSource(
	file: string,
	snapshots: Map<string, Snapshot>,
): { sha256: string; size: number; lines: string[] } | undefined {
	const before = snapshots.get(file);
	let searchedAt: number | undefined;
	if (!before?.sha256)
		for (const [dir, snapshot] of snapshots)
			if (snapshot.searchedAt !== undefined && file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep))
				searchedAt = snapshot.searchedAt;
	if (!before?.sha256 && searchedAt === undefined) return undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > CREDIT_MAX_BYTES) return undefined;
		const data = fs.readFileSync(file);
		const digest = sha256(data);
		if (before?.sha256) {
			if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)
				return undefined;
			if (digest !== before.sha256) return undefined;
		} else if (searchedAt !== undefined && Math.max(stat.mtimeMs, stat.ctimeMs) >= searchedAt) return undefined;
		const after = fs.statSync(file);
		if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== data.length)
			return undefined;
		return { sha256: digest, size: data.length, lines: data.toString("utf8").split("\n") };
	} catch {
		return undefined;
	}
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Read metadata survives transcript persistence and read-result deduplication. */
export function recordedLocalReads(details: unknown): LocalRead[] {
	if (!isRecord(details) || !Array.isArray(details.localReads)) return [];
	return details.localReads.filter(
		(read): read is LocalRead =>
			isRecord(read) &&
			typeof read.file === "string" &&
			path.isAbsolute(read.file) &&
			typeof read.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(read.sha256) &&
			nonnegative(read.size) &&
			typeof read.whole === "boolean" &&
			(read.whole ||
				(Array.isArray(read.lines) &&
					read.lines.length === 2 &&
					positive(read.lines[0]) &&
					positive(read.lines[1]) &&
					read.lines[1] >= read.lines[0])),
	);
}
