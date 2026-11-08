import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { ITEM_ENTRY_FIELDS, UPDATE_ENTRY_KEYS } from "./tool-schema.ts";

type Result = { content: unknown; details?: unknown };
type Batch = ReturnType<typeof textResult>;

/** One entry's outcome: its result text, or the reason it was refused. Later entries still run. */
function attempt(label: string, run: () => Result): { ok: boolean; text: string } {
	try {
		return { ok: true, text: contentText(run().content) };
	} catch (error) {
		return { ok: false, text: `${visibleControls(label)}: refused - ${errorMessage(error)}` };
	}
}

/** The head line and one line per entry. When every entry was refused nothing changed: that is an error result, not a success. */
function summary(verb: "Added" | "Updated", rows: readonly { ok: boolean; text: string }[]): Batch {
	const applied = rows.filter((row) => row.ok).length;
	const head = `${verb} ${applied} of ${rows.length}${applied < rows.length ? `; ${rows.length - applied} refused` : ""}.`;
	const text = [head, ...rows.map((row) => row.text)].join("\n");
	if (rows.length > 0 && applied === 0) throw new Error(text);
	return textResult(text);
}

/** `get` with several comma-separated ids: each item's record, or its own error row (unknown id). */
export function batchGet(ids: readonly string[], one: (id: string) => Result): Batch {
	const rows = ids.map((id) => attempt(id, () => one(id)));
	return textResult(rows.map((row) => row.text).join("\n\n---\n"));
}

/**
 * `update` with `updates`: each entry is a full single update (`one`), applied in order with every store check. A
 * refused entry is reported on its own line and the rest still apply.
 */
export function batchUpdate(
	updates: readonly Record<string, unknown>[],
	one: (entry: Record<string, unknown>) => Result,
): Batch {
	const rows = updates.map((entry, index) => {
		const label = typeof entry.id === "string" && entry.id.trim() ? entry.id : `updates[${index}]`;
		return attempt(label, () => {
			const unknown = Object.keys(entry).filter(
				(key) => !UPDATE_ENTRY_KEYS.includes(key) && !ITEM_ENTRY_FIELDS.includes(key),
			);
			if (unknown.length) throw new Error(`Unknown update fields: ${unknown.join(", ")}.`);
			return one(entry);
		});
	});
	return summary("Updated", rows);
}

/**
 * `add` with `items`: each entry is a full single add (`one`), applied in order with every store check. A refused entry
 * is reported on its own line, labelled by its title, and the rest still apply.
 */
export function batchAdd(
	entries: readonly Record<string, unknown>[],
	allowed: readonly string[],
	name: string,
	one: (entry: Record<string, unknown>) => Result,
): Batch {
	const rows = entries.map((entry, index) => {
		const named = [entry.title, entry.goal].find((v): v is string => typeof v === "string" && v.trim() !== "");
		return attempt(named ? `"${named.trim().slice(0, 60)}"` : `${name}[${index}]`, () => {
			const unknown = Object.keys(entry).filter((key) => !allowed.includes(key));
			if (unknown.length) throw new Error(`Unknown ${name} fields: ${unknown.join(", ")}.`);
			return one(entry);
		});
	});
	return summary("Added", rows);
}
