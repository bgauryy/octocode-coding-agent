import { type Static, Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-ai";
import type { ToolContext } from "../../../core/features/index.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { reasonSchema } from "../../shared/reason.ts";
import { elisionMarkers } from "../../shared/util.ts";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";
import type { QueryOutcome } from "../outcome.ts";
import { fileShapeError } from "../../tool-input/file-shape.ts";

/** The `file` tool's parameters and the text of its outcomes. */

const Edit = Type.Object({
	oldText: Type.String({ description: "Unique original text unless replaceAll" }),
	newText: Type.String(),
	line: Type.Optional(
		Type.Integer({ description: "1-based complete line; pair with the last read or written sourceSha256" }),
	),
	sourceSha256: Type.Optional(Type.String()),
	replaceAll: Type.Optional(Type.Boolean()),
});

// One flat object, not a union per `type`: strict tool calling takes no object unions, and no size bounds. Which
// operands go with which `type` is checked when the call runs (`fileShapeError`) before any changes are applied.
const Query = Type.Object({
	reason: Type.Optional(Type.String({ description: "Only if it differs from the call's reason" })),
	type: StringEnum(["edit", "write", "delete"] as const, {
		description: "edit: exact replacements; write: create or replace; delete: /rewind restores",
	}),
	path: Type.String(),
	edits: Type.Optional(Type.Array(Edit, { description: "edit: non-overlapping, matched against the original" })),
	content: Type.Optional(Type.String({ description: "write: complete file content" })),
	fromAttachment: Type.Optional(Type.String({ description: "write: SHA-256 from received team mail" })),
});

export const Params = Type.Object({
	queries: Type.Optional(Type.Array(Query)),
	patch: Type.Optional(Type.String({ description: "Codex apply_patch text" })),
	reason: reasonSchema(),
});

/** A query after preparation: an attachment write may now carry both its reference and the checked text. */
export interface FileQuery {
	type: Static<typeof Query>["type"];
	path: string;
	reason: string;
	edits?: Static<typeof Edit>[];
	content?: string;
	fromAttachment?: string;
}

/** `reason` replaced `reasoning`; a call recorded with the old name (a resumed session) still validates. */
const aliased = <T extends Record<string, unknown>>(value: T): T => {
	if (!("reasoning" in value)) return value;
	const { reasoning, ...rest } = value;
	return { ...rest, reason: rest.reason ?? reasoning } as unknown as T;
};

const CHANGE_TYPES: readonly unknown[] = ["edit", "write", "delete"];

/** A call that is one change itself (`{type, path, edits|content}`) with neither `queries` nor `patch`: the change moves into `queries`; its reason stays the call's. */
function wrapSingleChange(args: Record<string, unknown>): Record<string, unknown> {
	if (args.queries !== undefined || args.patch !== undefined) return args;
	if (!CHANGE_TYPES.includes(args.type) || typeof args.path !== "string") return args;
	const { reason, reasoning, ...change } = args;
	return {
		...(reason !== undefined ? { reason } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		queries: [change],
	};
}

/**
 * The call's arguments with `reasoning` (top level and per query) read as `reason`; a change without one takes the
 * call's. A single flat change becomes a one-item `queries`. A call with no `reason` of its own whose every change has
 * one takes theirs, joined, instead of failing validation: the reasons were given, only one level lower.
 */
export function renameReasoning(args: unknown): Static<typeof Params> {
	if (!isRecord(args)) return args as Static<typeof Params>;
	let renamed = aliased(wrapSingleChange(args));
	const shapeError = fileShapeError(renamed);
	if (shapeError) throw shapeError;
	const sent: unknown = renamed.queries;
	if (!Array.isArray(sent)) return renamed as Static<typeof Params>;
	if (renamed.reason === undefined && sent.length > 0) {
		const given = sent.map((query: unknown) => (isRecord(query) ? aliased(query).reason : undefined));
		if (given.every((reason) => typeof reason === "string" && reason.trim()))
			renamed = { ...renamed, reason: [...new Set(given as string[])].join("; ") };
	}
	const queries = sent.map((query: unknown) => {
		if (!isRecord(query)) return query;
		const named = aliased(query);
		return named.reason === undefined && typeof renamed.reason === "string"
			? { ...named, reason: renamed.reason }
			: named;
	});
	return { ...renamed, queries } as Static<typeof Params>;
}

export interface PreparedChange {
	query: FileQuery;
	mode: "edit" | "write" | "delete";
	digest: string | null;
	canonicalPath?: string;
}

export interface FileReplacementOwner {
	enabled(input: Record<string, unknown>, cwd: string): boolean;
	refresh(ctx: ToolContext): Promise<void>;
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
				`${index + 1}. ${outcome.ok ? "OK" : "FAILED"} ${outcome.type} ${outcome.path}: ${outcome.ok ? withoutPath(outcome.message, outcome.path) : outcome.message}${outcome.ok && outcome.sourceSha256 ? ` sourceSha256=${outcome.sourceSha256}` : ""}`,
		)
		.join("\n");
}

/**
 * The text of a `file` result. A `queries` batch (`total` queries, more than one) in which any failed starts with
 * "k of n failed", so a partly applied batch does not read as done; a single query and a patch (which stops at its
 * first failure) keep the plain list.
 */
export function batchText(outcomes: QueryOutcome[], failed: number, total?: number): string {
	const list = formatOutcomes(outcomes);
	return failed > 0 && total !== undefined && total > 1 ? `${failed} of ${total} failed\n${list}` : list;
}
