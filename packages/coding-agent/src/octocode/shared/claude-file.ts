import type { JsonObject } from "@octocodeai/octocode-ai";
import { isRecord } from "./util.ts";

export interface FileInputReplacement {
	index: number;
	input: JsonObject;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`Rewritten ${field} must be a string`);
	return value;
}

/** Reverse a Claude file-query projection without changing unrelated batch queries or native reasoning. */
export function rewriteFileQuery(
	input: Record<string, unknown>,
	index: number,
	updated: JsonObject,
): Record<string, unknown> {
	if (!Array.isArray(input.queries) || !isRecord(input.queries[index]))
		throw new Error("Missing file query for hook rewrite");
	const previous = input.queries[index];
	const file = text(updated.file_path, "file_path");
	let query: Record<string, unknown>;
	if (previous.type === "write") {
		query = {
			type: "write",
			path: file,
			content: text(updated.content, "content"),
			reasoning: previous.reasoning,
		};
	} else if (previous.type === "delete") {
		query = { type: "delete", path: file, reasoning: previous.reasoning };
	} else {
		const multiple = Array.isArray(previous.edits) && previous.edits.length !== 1;

		const edits = multiple ? updated.edits : [updated];
		if (!Array.isArray(edits)) throw new Error("Rewritten edits must be an array");
		query = {
			type: previous.type,
			path: file,
			reasoning: previous.reasoning,
			edits: edits.map((edit) => {
				if (!isRecord(edit)) throw new Error("Rewritten edit must be an object");
				if (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean")
					throw new Error("Rewritten replace_all must be a boolean");
				return {
					oldText: text(edit.old_string, "old_string"),
					newText: text(edit.new_string, "new_string"),
					...(typeof edit.replace_all === "boolean" ? { replaceAll: edit.replace_all } : {}),
				};
			}),
		};
	}
	return {
		...input,
		queries: input.queries.map((item, position) => (position === index ? query : item)),
	};
}
