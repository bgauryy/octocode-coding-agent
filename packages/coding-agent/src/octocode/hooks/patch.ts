import type { JsonObject } from "@octocodeai/octocode-ai";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import { validatePatchPath } from "../shared/file-input.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { canonicalPath } from "../shared/home/repo.ts";
import { resolveToolPath } from "../shared/home.ts";

export const CODEX_PATCH_NAMES = ["apply_patch", "Write", "Edit"];

const EDIT_PROJECTION_ERROR =
	"Native edits require a snapshot-aware apply_patch adapter; substring edits cannot be projected losslessly";

/**
 * The file owner's projection of one edit query into an `*** Update File` section (header first) from the file's
 * verified read; it throws when that read is missing or the section would not reproduce the tool's write exactly.
 */
export type EditProjector = (query: Record<string, unknown>, path: string, cwd: string) => string[];

/** What edit projection needs: the file owner's projector and the directory relative query paths resolve against. */
export interface PatchSnapshots {
	projectEdit: EditProjector;
	cwd: string;
}

function projectEdit(query: Record<string, unknown>, path: string, snapshots: PatchSnapshots | undefined): string[] {
	if (!snapshots) throw new Error(`${EDIT_PROJECTION_ERROR} (no file snapshot is available here)`);
	try {
		return snapshots.projectEdit(query, path, snapshots.cwd);
	} catch (error) {
		throw new Error(`${EDIT_PROJECTION_ERROR} (${errorMessage(error)})`);
	}
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
function patchPath(value: unknown): string {
	if (typeof value !== "string") throw new Error("Patch path must be a string");
	return validatePatchPath(value);
}

/**
 * Project only operations whose bytes are representable without reading unapproved file contents: writes and deletes
 * from the query alone, edits from the file the file guard verifies was read (`snapshots`; without it edits are refused).
 */
export function projectCodexPatch(input: Record<string, unknown>, snapshots?: PatchSnapshots): string {
	if (typeof input.patch === "string") {
		parsePatch(input.patch);
		return input.patch;
	}
	if (!Array.isArray(input.queries) || input.queries.length === 0) throw new Error("Patch requires file queries");
	const lines = [BEGIN];
	const targets = new Map<string, number>();
	if (snapshots)
		for (const query of input.queries)
			if (isRecord(query) && typeof query.path === "string") {
				const key = canonicalPath(resolveToolPath(snapshots.cwd, query.path));
				targets.set(key, (targets.get(key) ?? 0) + 1);
			}
	for (const query of input.queries) {
		if (!isRecord(query)) throw new Error("Invalid file query for patch projection");
		const path = patchPath(query.path);
		if (query.type === "edit") {
			// Later queries on the same file see the earlier ones' result, which one Update section per query cannot express.
			if (snapshots && (targets.get(canonicalPath(resolveToolPath(snapshots.cwd, path))) ?? 0) > 1)
				throw new Error(`${EDIT_PROJECTION_ERROR} (${path} is changed by more than one query in this batch)`);
			lines.push(...projectEdit(query, path, snapshots));
		} else if (query.type === "delete") lines.push(`*** Delete File: ${path}`);
		else if (query.type === "write") {
			if (
				typeof query.content !== "string" ||
				query.content.includes("\r") ||
				(query.content !== "" && !query.content.endsWith("\n"))
			) {
				throw new Error(
					"Lossless apply_patch projection requires LF-only, newline-terminated write content (or empty content)",
				);
			}
			lines.push(`*** Add File: ${path}`);
			if (query.content)
				lines.push(
					...query.content
						.slice(0, -1)
						.split("\n")
						.map((line) => `+${line}`),
				);
		} else throw new Error(`${EDIT_PROJECTION_ERROR} (unsupported query type)`);
	}
	return [...lines, END].join("\n");
}

/** Reverse supported patch operations; the caller still validates schema, reservations and permissions. */
export function rewriteCodexPatch(input: Record<string, unknown>, updated: JsonObject): Record<string, unknown> {
	if (typeof updated.command !== "string") throw new Error("Rewritten patch command must be a string");
	const parsed = parsePatch(updated.command);
	for (const h of parsed.hunks) {
		patchPath(h.path);
		if (h.kind === "update" && h.move_path !== null) patchPath(h.move_path);
	}
	const reason = Array.isArray(input.queries)
		? input.queries
				.filter(isRecord)
				.map((q) => q.reason)
				.filter((value) => typeof value === "string")
				.join("; ")
		: input.reason;
	return {
		patch: updated.command,
		reason: typeof reason === "string" && reason ? reason : "Apply the patch rewritten by a PreToolUse hook",
	};
}
