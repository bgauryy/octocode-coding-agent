import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { expandPath } from "../../core/tools/path-utils.ts";
import type { ToolChange, ToolEffect } from "../../core/features/types.ts";
import { fileShapeError } from "./file-shape.ts";
import { parsePatch } from "./codex-patch/patch.ts";
interface PatchChange {
	type: "write" | "edit" | "delete";
	path: string;
	reason: string;
	edits?: { oldText: string; newText: string }[];
	content?: string;
	movePath?: string;
}
export function validatePatchPath(value: string): string {
	if (
		!value ||
		value.trim() !== value ||
		/[\r\n\0]/.test(value) ||
		/^(?:~(?:[\\/]|$)|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(value) ||
		expandPath(value) !== value
	)
		throw new Error(
			"Patch path must be a local filesystem path without native path normalization, URI or drive prefixes, surrounding whitespace, newlines or NUL",
		);
	return value;
}
export function patchChanges(patch: string, reason: string): PatchChange[] {
	return parsePatch(patch).hunks.map((h) => {
		validatePatchPath(h.path);
		if (h.kind === "add") return { type: "write", path: h.path, content: h.content, reason };
		if (h.kind === "delete") return { type: "delete", path: h.path, reason };
		if (h.move_path !== null) validatePatchPath(h.move_path);
		return {
			type: "edit",
			path: h.path,
			reason,
			edits: h.chunks.map((c) => ({
				oldText: c.old.join("\n"),
				newText: c.new.join("\n"),
			})),
			...(h.move_path ? { movePath: h.move_path } : {}),
		};
	});
}
/** Refuses a `file` call that is not exactly one of `queries` or `patch`, with the corrected-call text the tool itself gives. */
export function validateFileInput(input: Record<string, unknown>): void {
	const shapeError = fileShapeError(input);
	if (shapeError) throw shapeError;
	if (input.patch !== undefined && typeof input.patch !== "string") throw new Error("Patch must be a string");
	if (input.queries !== undefined && !Array.isArray(input.queries)) throw new Error("Queries must be an array");
}
/**
 * What a `file` call changes, as its declared effect: each change's path and type, a move's destination as a write.
 * `undefined` when the call names changes but none can be read (a patch that does not parse), so a guard cannot treat
 * it as a call that changes nothing.
 */
function fileToolChanges(input: Record<string, unknown>): ToolChange[] | undefined {
	const changes = fileChanges(input).flatMap((query): ToolChange[] => {
		if (typeof query.path !== "string") return [];
		const type = query.type === "write" || query.type === "edit" || query.type === "delete" ? query.type : undefined;
		return [
			{ path: query.path, ...(type ? { type } : {}), detail: query },
			...(typeof query.movePath === "string" ? [{ path: query.movePath, type: "write" as const, detail: query }] : []),
		];
	});
	return changes.length === 0 && (input.patch !== undefined || input.queries !== undefined) ? undefined : changes;
}

/** The `file` tool's declared effect: it writes the files its queries or patch name. */
export const FILE_TOOL_EFFECT: ToolEffect = { kind: "write", changes: fileToolChanges };

/** Files a `file` call is about to change; empty for any other tool. */
export function mutatedPaths(toolName: string, input: unknown): string[] {
	if (typeof input !== "object" || input === null || toolName !== "file") return [];
	return (fileToolChanges(input as Record<string, unknown>) ?? []).map((change) => change.path);
}

export function fileChanges(input: Record<string, unknown>): Record<string, unknown>[] {
	if (typeof input.patch === "string") {
		try {
			return patchChanges(input.patch, typeof input.reason === "string" ? input.reason : "Apply patch").map(
				(change) => ({ ...change }),
			);
		} catch {
			return [];
		}
	}
	return Array.isArray(input.queries) ? input.queries.filter(isRecord) : [];
}
