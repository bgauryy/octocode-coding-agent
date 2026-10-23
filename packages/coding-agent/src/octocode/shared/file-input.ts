import { isRecord } from "./util.ts";
import { expandPath } from "../../core/tools/path-utils.ts";
import { parsePatch } from "./codex-patch/patch.ts";
interface PatchChange {
	type: "write" | "edit" | "delete";
	path: string;
	reasoning: string;
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
export function patchChanges(patch: string, reasoning: string): PatchChange[] {
	return parsePatch(patch).hunks.map((h) => {
		validatePatchPath(h.path);
		if (h.kind === "add")
			return { type: "write", path: h.path, content: h.content, reasoning };
		if (h.kind === "delete") return { type: "delete", path: h.path, reasoning };
		if (h.move_path !== null) validatePatchPath(h.move_path);
		return {
			type: "edit",
			path: h.path,
			reasoning,
			edits: h.chunks.map((c) => ({
				oldText: c.old.join("\n"),
				newText: c.new.join("\n"),
			})),
			...(h.move_path ? { movePath: h.move_path } : {}),
		};
	});
}
export function validateFileInput(input: Record<string, unknown>): void {
	if ((input.patch !== undefined) === (input.queries !== undefined))
		throw new Error("Provide exactly one of queries or patch");
	if (input.patch !== undefined && typeof input.patch !== "string")
		throw new Error("Patch must be a string");
	if (input.queries !== undefined && !Array.isArray(input.queries))
		throw new Error("Queries must be an array");
}
export function fileChanges(
	input: Record<string, unknown>,
): Record<string, unknown>[] {
	if (typeof input.patch === "string") {
		try {
			return patchChanges(
				input.patch,
				typeof input.reasoning === "string" ? input.reasoning : "Apply patch",
			).map((change) => ({ ...change }));
		} catch {
			return [];
		}
	}
	return Array.isArray(input.queries) ? input.queries.filter(isRecord) : [];
}
