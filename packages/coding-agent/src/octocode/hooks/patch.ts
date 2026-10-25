import type { JsonObject } from "@octocodeai/octocode-ai";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import { validatePatchPath } from "../shared/file-input.ts";
import { isRecord } from "../../utils/guards.ts";

export const CODEX_PATCH_NAMES = ["apply_patch", "Write", "Edit"];

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
function patchPath(value: unknown): string {
	if (typeof value !== "string") throw new Error("Patch path must be a string");
	return validatePatchPath(value);
}

/** Project only operations whose bytes are representable without reading unapproved file contents. */
export function projectCodexPatch(input: Record<string, unknown>): string {
	if (typeof input.patch === "string") {
		parsePatch(input.patch);
		return input.patch;
	}
	if (!Array.isArray(input.queries) || input.queries.length === 0) throw new Error("Patch requires file queries");
	const lines = [BEGIN];
	for (const query of input.queries) {
		if (!isRecord(query)) throw new Error("Invalid file query for patch projection");
		const path = patchPath(query.path);
		if (query.type === "delete") lines.push(`*** Delete File: ${path}`);
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
		} else
			throw new Error(
				"Native edits require a snapshot-aware apply_patch adapter; substring edits cannot be projected losslessly",
			);
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
