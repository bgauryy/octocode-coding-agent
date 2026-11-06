import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { UPDATE_ENTRY_KEYS } from "./tool-schema.ts";

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
			const unknown = Object.keys(entry).filter((key) => !UPDATE_ENTRY_KEYS.includes(key));
			if (unknown.length) throw new Error(`Unknown update fields: ${unknown.join(", ")}.`);
			return one(entry);
		});
	});
	const applied = rows.filter((row) => row.ok).length;
	const head = `Updated ${applied} of ${rows.length}${applied < rows.length ? `; ${rows.length - applied} refused` : ""}.`;
	return textResult([head, ...rows.map((row) => row.text)].join("\n"));
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
	const applied = rows.filter((row) => row.ok).length;
	const head = `Added ${applied} of ${rows.length}${applied < rows.length ? `; ${rows.length - applied} refused` : ""}.`;
	return textResult([head, ...rows.map((row) => row.text)].join("\n"));
}
