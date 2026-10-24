import { normalizeToLF } from "../../../core/tools/edit-diff.ts";
import { sha256 } from "../../../utils/atomic-file.ts";
import type { FileGuard } from "./guard.ts";
import type { FileQuery } from "./queries.ts";

/** Bound repeated-line scans; ordinary contextual edits remain available when a wider block is needed. */
const MAX_CONTEXT_LINES = 128;

/** Resolve optional exact complete-line anchors into the existing text edit contract. No writing occurs here. */
export function resolveAnchoredEdits(query: FileQuery, data: Buffer, guard: FileGuard, file: string): FileQuery {
	if (query.type !== "edit" || !query.edits?.some((edit) => edit.line !== undefined || edit.sourceSha256 !== undefined))
		return query;
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
		if (
			!Number.isSafeInteger(edit.line) ||
			(edit.line ?? 0) < 1 ||
			!edit.sourceSha256 ||
			!/^[a-f0-9]{64}$/.test(edit.sourceSha256) ||
			edit.sourceSha256 !== digest ||
			edit.replaceAll ||
			/[\r\n]/.test(edit.oldText) ||
			edit.newText.includes("\r") ||
			lines[(edit.line ?? 0) - 1] !== edit.oldText
		)
			fresh();
		const at = edit.line! - 1;
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
