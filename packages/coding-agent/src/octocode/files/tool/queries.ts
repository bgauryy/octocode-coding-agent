import { type Static, Type } from "typebox";
import type { ExtensionToolContext } from "../../../core/extensions/index.ts";
import { isRecord } from "../../../utils/guards.ts";
import { elisionMarkers, escapeRegExp } from "../../shared/util.ts";
import type { QueryOutcome } from "../render.ts";

/** The `file` tool's parameters and the text of its outcomes. */

const QuerySchema = Type.Object({
	reason: Type.String({ description: "Why this change is needed" }),
	// A plain string enum (what octocode-ai's StringEnum emits) keeps the schema portable across providers.
	type: Type.Unsafe<"edit" | "write" | "delete">({
		type: "string",
		enum: ["edit", "write", "delete"],
		description:
			"edit: exact replacements; write: create/replace; delete: irreversible, only when the task requires it",
	}),
	path: Type.String({ description: "Absolute path or relative to cwd" }),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String({
					description: "Exact text; with line, the whole original line without its terminator",
				}),
				newText: Type.String({ description: "Replacement text" }),
				line: Type.Optional(Type.Integer({ description: "1-based line anchor; needs sourceSha256" })),
				sourceSha256: Type.Optional(
					Type.String({
						description: "SHA-256 of the whole file as read; needs line",
					}),
				),
				replaceAll: Type.Optional(
					Type.Boolean({
						description: "All non-overlapping matches; default false.",
					}),
				),
			}),
			{
				description: "Edits match original content; no overlaps.",
			},
		),
	),
	content: Type.Optional(Type.String({ description: "For write: complete file content" })),
});

export const Params = Type.Object({
	queries: Type.Optional(Type.Array(QuerySchema)),
	patch: Type.Optional(
		Type.String({
			description: "Codex apply_patch text; use instead of queries",
		}),
	),
	reason: Type.Optional(Type.String({ description: "Why this patch is needed" })),
});
export type FileQuery = Static<typeof QuerySchema>;

/** `reason` replaced `reasoning`; a call recorded with the old name (a resumed session) still validates. */
const aliased = <T extends Record<string, unknown>>(value: T): T => {
	if (!("reasoning" in value)) return value;
	const { reasoning, ...rest } = value;
	return { ...rest, reason: rest.reason ?? reasoning } as unknown as T;
};

/** The call's arguments with `reasoning` (top level and per query) read as `reason`. */
export function renameReasoning(args: unknown): Static<typeof Params> {
	if (!isRecord(args)) return args as Static<typeof Params>;
	const renamed = aliased(args);
	if (!Array.isArray(renamed.queries)) return renamed;
	const queries = renamed.queries.map((query) => (isRecord(query) ? aliased(query) : query));
	return { ...renamed, queries };
}

export interface PreparedChange {
	query: FileQuery;
	mode: "edit" | "write" | "delete";
	digest: string | null;
	canonicalPath?: string;
}

export interface FileReplacementOwner {
	enabled(input: Record<string, unknown>, cwd: string): boolean;
	refresh(ctx: ExtensionToolContext): Promise<void>;
	committed?(id: string, input: Record<string, unknown>, cwd: string): void;
}

/** The batch's `purpose`: what its changes' `reason` fields say, in order; none when they say nothing (the assistant's message then stands in). */
export function changePurpose(queries: readonly Pick<FileQuery, "reason">[]): {
	purpose?: string;
} {
	const said = [...new Set(queries.map((query) => query.reason?.trim()).filter(Boolean))];
	return said.length > 0 ? { purpose: said.join("; ") } : {};
}

/** The first output-cut placeholder a change would add to the file (one already in the file or the replaced text is fine). */
export function copiedElision(
	query: Pick<FileQuery, "type" | "edits" | "content">,
	original: string,
): string | undefined {
	const added =
		query.type === "write"
			? [{ oldText: "", newText: query.content ?? "" }]
			: query.type === "edit"
				? (query.edits ?? [])
				: [];
	for (const { oldText, newText } of added) {
		const found = elisionMarkers(newText).find((marker) => !oldText.includes(marker) && !original.includes(marker));
		if (found) return found;
	}
	return undefined;
}

/** Octocode's messages end with "in <path>." or "to <path>"; the outcome line already names the path. */
function withoutPath(message: string, file: string): string {
	return message.replace(new RegExp(`\\s+(?:in|to) ${escapeRegExp(file)}\\.?$`), "").replace(/^Successfully /, "");
}

export function formatOutcomes(outcomes: QueryOutcome[]): string {
	return outcomes
		.map(
			(outcome, index) =>
				`${index + 1}. ${outcome.ok ? "OK" : "FAILED"} ${outcome.type} ${outcome.path}: ${outcome.ok ? withoutPath(outcome.message, outcome.path) : outcome.message}`,
		)
		.join("\n");
}
