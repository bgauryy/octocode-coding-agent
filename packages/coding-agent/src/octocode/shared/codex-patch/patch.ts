/** Adapted from OpenAI Codex 8eaf5fd115f036d207be236009938261758e30f2 apply-patch.
 * Copyright 2025 OpenAI. Apache-2.0; see LICENSE and NOTICE in this directory.
 * Pure parsing and transformation only; the native file owner authorizes and applies changes.
 */
interface PatchChunk {
	context: string | null;
	old: string[];
	new: string[];
	context_indices: [number, number][];
	eof: boolean;
}
type PatchHunk =
	| { kind: "add"; path: string; content: string }
	| { kind: "delete"; path: string }
	| {
			kind: "update";
			path: string;
			move_path: string | null;
			chunks: PatchChunk[];
	  };
export interface ParsedPatch {
	patch: string;
	environment_id: string | null;
	hunks: PatchHunk[];
}
/** Rust's `char::is_whitespace` (Unicode White_Space), all in the BMP; JS `trim` differs (U+FEFF in, U+0085 out). */
const isRustSpace = (code: number): boolean =>
	(code >= 0x09 && code <= 0x0d) ||
	code === 0x20 ||
	code === 0x85 ||
	code === 0xa0 ||
	code === 0x1680 ||
	(code >= 0x2000 && code <= 0x200a) ||
	code === 0x2028 ||
	code === 0x2029 ||
	code === 0x202f ||
	code === 0x205f ||
	code === 0x3000;
/** Scans instead of `\s+$`, which backtracks quadratically on a whitespace run followed by text. */
const trimEnd = (text: string): string => {
	let end = text.length;
	while (end > 0 && isRustSpace(text.charCodeAt(end - 1))) end--;
	return text.slice(0, end);
};
const trim = (text: string): string => {
	let start = 0;
	while (start < text.length && isRustSpace(text.charCodeAt(start))) start++;
	return trimEnd(text.slice(start));
};
const chunk = (): PatchChunk => ({
	context: null,
	old: [],
	new: [],
	context_indices: [],
	eof: false,
});
const fail = (message: string): never => {
	throw new Error(`Invalid patch: ${message}`);
};

export function parsePatch(value: string): ParsedPatch {
	let lines = trim(value).split(/\r?\n/);
	if (lines.length >= 4 && ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1)!.endsWith("EOF"))
		lines = lines.slice(1, -1);
	if (trim(lines[0] ?? "") !== "*** Begin Patch" || trim(lines.at(-1) ?? "") !== "*** End Patch")
		fail("missing patch boundaries");
	const result: ParsedPatch = {
		patch: lines.join("\n"),
		environment_id: null,
		hunks: [],
	};
	let current: PatchHunk | undefined;
	const finish = () => {
		if (
			current?.kind === "update" &&
			(!current.chunks.length || current.chunks.some((c) => !c.old.length && !c.new.length))
		)
			fail("empty update hunk");
	};
	for (const line of lines.slice(1, -1)) {
		const trimmed = trim(line);
		if (!current && trimmed.startsWith("*** Environment ID:")) {
			if (result.environment_id !== null || !trim(trimmed.slice(19))) fail("invalid environment id");
			result.environment_id = trim(trimmed.slice(19));
			continue;
		}
		const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(trimmed);
		if (header) {
			finish();
			const path = header[2];
			current =
				header[1] === "Add"
					? { kind: "add", path, content: "" }
					: header[1] === "Delete"
						? { kind: "delete", path }
						: { kind: "update", path, move_path: null, chunks: [] };
			result.hunks.push(current);
			continue;
		}
		if (current?.kind === "add" && line.startsWith("+")) {
			current.content += line.slice(1) + "\n";
			continue;
		}
		if (current?.kind !== "update") fail("unexpected patch line");
		const update = current as Extract<PatchHunk, { kind: "update" }>;
		let last = update.chunks.at(-1);
		if (last?.eof) {
			if (!trimmed) continue;
			if (trimmed !== "@@" && !trimmed.startsWith("@@ ")) fail("expected context after EOF");
		}
		if (!update.chunks.length && update.move_path === null && trimmed.startsWith("*** Move to: ")) {
			update.move_path = trimmed.slice(13);
			continue;
		}
		if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
			if (last && !last.old.length && !last.new.length) fail("empty update chunk");
			last = chunk();
			if (trimmed !== "@@") last.context = trimmed.slice(3);
			update.chunks.push(last);
			continue;
		}
		if (trimmed === "*** End of File") {
			if (!last || (!last.old.length && !last.new.length)) fail("empty EOF chunk");
			last!.eof = true;
			continue;
		}
		if (!last) {
			last = chunk();
			update.chunks.push(last);
		}
		if (!line || line.startsWith(" ")) {
			last.context_indices.push([last.old.length, last.new.length]);
			last.old.push(line.slice(1));
			last.new.push(line.slice(1));
		} else if (line.startsWith("+")) last.new.push(line.slice(1));
		else if (line.startsWith("-")) last.old.push(line.slice(1));
		else fail("expected context, addition or removal");
	}
	finish();
	return result;
}

function normalized(line: string): string {
	return trim(line)
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018-\u201b]/g, "'")
		.replace(/[\u201c-\u201f]/g, '"')
		.replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}
function seek(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (!pattern.length) return start;
	if (pattern.length > lines.length) return undefined;
	const first = eof ? Math.max(start, lines.length - pattern.length) : start;
	for (const normalize of [(s: string) => s, (s: string) => trimEnd(s), (s: string) => trim(s), normalized]) {
		for (let i = first; i <= lines.length - pattern.length; i++)
			if (pattern.every((p, j) => normalize(p) === normalize(lines[i + j]))) return i;
	}
	return undefined;
}

export function transformPatch(source: string, chunks: PatchChunk[]): string {
	const sourceLines: { text: string; ending: string }[] = [];
	const regex = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) && match[0]) sourceLines.push({ text: match[1], ending: match[2] });
	const ending = sourceLines.find((l) => l.ending)?.ending || "\n";
	const lines = sourceLines.map((l) => l.text);
	const replacements: { start: number; count: number; lines: string[] }[] = [];
	let cursor = 0;
	for (const c of chunks) {
		if (c.context !== null) {
			const i = seek(lines, [c.context], cursor, false);
			if (i === undefined) fail("context not found");
			cursor = i! + 1;
		}
		if (!c.old.length) {
			replacements.push({ start: lines.length, count: 0, lines: c.new });
			continue;
		}
		let old = c.old,
			next = c.new,
			at = seek(lines, old, cursor, c.eof);
		if (at === undefined && old.at(-1) === "") {
			old = old.slice(0, -1);
			if (next.at(-1) === "") next = next.slice(0, -1);
			at = seek(lines, old, cursor, c.eof);
		}
		if (at === undefined) fail("expected lines not found");
		const start = at as number;
		let oi = 0,
			ni = 0;
		for (const [oc, nc] of c.context_indices) {
			if (oc >= old.length || nc >= next.length) break;
			if (oi !== oc || ni !== nc)
				replacements.push({
					start: start + oi,
					count: oc - oi,
					lines: next.slice(ni, nc),
				});
			oi = oc + 1;
			ni = nc + 1;
		}
		if (oi !== old.length || ni !== next.length)
			replacements.push({
				start: start + oi,
				count: old.length - oi,
				lines: next.slice(ni),
			});
		cursor = start + old.length;
	}
	replacements.sort((a, b) => a.start - b.start);
	const result: { text: string; ending: string }[] = [];
	let offset = 0;
	for (const replacement of replacements) {
		if (replacement.start < offset) fail("overlapping replacements");
		result.push(
			...sourceLines.slice(offset, replacement.start),
			...replacement.lines.map((text) => ({ text, ending })),
		);
		offset = replacement.start + replacement.count;
	}
	result.push(...sourceLines.slice(offset));
	return result.map((l) => l.text + (l.ending || ending)).join("");
}
