import { normalizeToLF } from "../../../core/tools/edit-diff.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import type { FileGuard } from "./guard.ts";
import type { FileQuery } from "./queries.ts";

/** Bound repeated-line scans; ordinary contextual edits remain available when a wider block is needed. */
const MAX_CONTEXT_LINES = 128;

/** Name the first malformed field of an anchored edit, with its fix; undefined when the shape is valid. */
function anchorShapeError(edit: NonNullable<FileQuery["edits"]>[number]): string | undefined {
	if (edit.line === undefined)
		return "sourceSha256 needs line (the 1-based line of oldText); add line or drop sourceSha256.";
	if (edit.sourceSha256 === undefined)
		return "line needs sourceSha256 (the sha256 from the complete read of this file); add it or drop line.";
	if (!Number.isSafeInteger(edit.line) || edit.line < 1) return "line must be an integer of at least 1.";
	if (!/^[a-f0-9]{64}$/.test(edit.sourceSha256))
		return "sourceSha256 must be 64 lowercase hex characters, the digest from the complete read.";
	if (edit.replaceAll) return "replaceAll cannot be combined with line; drop replaceAll or drop line and sourceSha256.";
	if (/[\r\n]/.test(edit.oldText))
		return "oldText must be the single complete line at line; for a multi-line change use an edit without line.";
	if (edit.newText.includes("\r")) return "newText must not contain a carriage return; use \\n line breaks.";
	return undefined;
}

/** Resolve optional exact complete-line anchors into the existing text edit contract. No writing occurs here. */
export function resolveAnchoredEdits(query: FileQuery, data: Buffer, guard: FileGuard, file: string): FileQuery {
	if (query.type !== "edit" || !query.edits?.some((edit) => edit.line !== undefined || edit.sourceSha256 !== undefined))
		return query;
	for (const edit of query.edits) {
		if (edit.line === undefined && edit.sourceSha256 === undefined) continue;
		const bad = anchorShapeError(edit);
		if (bad) throw new Error(`${query.path}: invalid anchored edit: ${bad}`);
	}
	const fresh = (): never => {
		throw new Error(
			`${query.path}: anchored edit source or line is ambiguous or stale. Read the complete file again before editing it.`,
		);
	};
	const digest = sha256(data);
	if (guard.wholeReadDigest(file) !== digest) fresh();
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return fresh();
	}
	if (source.startsWith("\ufeff")) source = source.slice(1);
	// The existing engine restores one detected line ending. Reject mixed endings to avoid rewriting untouched lines.
	const crlf = source.includes("\r\n");
	if (source.replace(/\r\n/g, "").includes("\r") || (crlf && source.replace(/\r\n/g, "").includes("\n"))) fresh();
	const normalized = normalizeToLF(source);
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	const edits = query.edits.map((edit) => {
		if (edit.line === undefined && edit.sourceSha256 === undefined) return edit;
		// The digest of an earlier version is accepted only through this tool's own edits since, at the line they moved it to.
		const line = edit.sourceSha256 === digest ? edit.line! : guard.ownLine(file, edit.sourceSha256!, edit.line!);
		if (line === undefined || lines[line - 1] !== edit.oldText) fresh();
		const at = line! - 1;
		let first = at;
		let last = at;
		let oldText = lines[at];
		const occurrences = (value: string) => normalized.split(value).length - 1;
		while ((!oldText || occurrences(oldText) !== 1) && (first > 0 || last < lines.length - 1)) {
			if (last - first + 1 >= MAX_CONTEXT_LINES) fresh();
			if (first > 0) first--;
			if (last < lines.length - 1 && last - first + 1 < MAX_CONTEXT_LINES) last++;
			oldText = lines.slice(first, last + 1).join("\n");
		}
		if (!oldText || occurrences(oldText) !== 1) fresh();
		const selected = at - first;
		const replacement = lines.slice(first, last + 1);
		replacement[selected] = edit.newText;
		return { oldText, newText: replacement.join("\n") };
	});
	return { ...query, edits };
}
