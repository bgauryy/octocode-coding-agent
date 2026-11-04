import fs from "node:fs";
import * as Diff from "diff";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "../../../core/tools/edit-diff.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { splitBom } from "../../../../../common/src/text.ts";
import { parsePatch, transformPatch } from "../../shared/codex-patch/patch.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { resolveAnchoredEdits } from "./anchored.ts";
import type { FileGuard } from "./guard.ts";
import type { FileQuery } from "./queries.ts";

/** Context widths tried in turn; the whole file is the last resort when nearer context is ambiguous. */
const CONTEXTS = [3, 12, Number.POSITIVE_INFINITY];

const refuse = (detail: string): never => {
	throw new Error(detail);
};

/** Line texts split the way `transformPatch` splits its source, so hunk lines and the applier agree. */
function lineTexts(source: string): string[] {
	const lines: string[] = [];
	const regex = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) && match[0]) lines.push(match[1]);
	return lines;
}

/** `@@` chunks with `context` unchanged lines around each change, merging changes whose context would overlap. */
function chunks(before: string[], after: string[], context: number): string[] {
	const ops = Diff.diffArrays(before, after).flatMap((part) =>
		part.value.map((text) => `${part.added ? "+" : part.removed ? "-" : " "}${text}`),
	);
	const changed = ops.flatMap((op, index) => (op.startsWith(" ") ? [] : [index]));
	const lines: string[] = [];
	for (let i = 0; i < changed.length; i++) {
		const start = Math.max(0, changed[i] - context);
		while (i + 1 < changed.length && changed[i + 1] - changed[i] - 1 <= 2 * context) i++;
		const end = Math.min(ops.length - 1, changed[i] + context);
		lines.push("@@", ...ops.slice(start, end + 1));
	}
	return lines;
}

function editQuery(query: Record<string, unknown>, path: string): FileQuery {
	const edits = query.edits;
	if (!Array.isArray(edits) || !edits.length) return refuse("edit needs a non-empty edits array");
	for (const edit of edits)
		if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string")
			return refuse("invalid edit");
	return { ...(query as FileQuery), path };
}

/**
 * The `*** Update File` section (header first) for one edit query, for a Codex apply_patch hook: the guard must hold a
 * current read of the file (unchanged since, digest-checked when known), the edits are applied to those bytes with this
 * tool's own engine (anchors, exact-once or replaceAll matching, line endings and BOM), and the section is kept only when
 * applying it to the same bytes yields exactly what the tool will write. Anything else throws, never approximated.
 */
export function projectEditHunk(query: Record<string, unknown>, path: string, guard: FileGuard, cwd: string): string[] {
	const native = editQuery(query, path);
	const file = resolveToolPath(cwd, path);
	const inspection = guard.inspect(file, "edit", path);
	if (inspection.refusal) return refuse(inspection.refusal);
	if (inspection.unread) return refuse(`${path} was not read in this session`);
	if (!inspection.current || inspection.stale) return refuse(`${path} has no current verified read`);
	let data: Buffer;
	try {
		data = fs.readFileSync(file);
	} catch {
		return refuse(`${path} could not be read`);
	}
	if (inspection.expected !== undefined && inspection.expected !== sha256(data))
		return refuse(`${path} changed since it was read`);
	const source = data.toString("utf8");
	if (!Buffer.from(source, "utf8").equals(data)) return refuse(`${path} is not valid UTF-8`);
	const edits = resolveAnchoredEdits(native, data, guard, file).edits ?? [];
	const { bom, text } = splitBom(source);
	const { newContent } = applyEditsToNormalizedContent(normalizeToLF(text), edits, path);
	const expected = bom + restoreLineEndings(newContent, detectLineEnding(text));
	const before = lineTexts(source);
	const after = lineTexts(expected);
	for (const context of CONTEXTS) {
		const section = [`*** Update File: ${path}`, ...chunks(before, after, context)];
		try {
			const [hunk] = parsePatch(["*** Begin Patch", ...section, "*** End Patch"].join("\n")).hunks;
			if (hunk?.kind === "update" && transformPatch(source, hunk.chunks) === expected) return section;
		} catch {
			/* Ambiguous or unparsable at this width: try wider context. */
		}
	}
	return refuse(`an apply_patch hunk cannot reproduce the edited bytes of ${path} exactly`);
}
