import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { contentText, textResult } from "../shared/util.ts";
import { parseRef } from "./item.ts";

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

/** Refuses an entry that carries a field its operation does not take, naming the fields it does (`shown`, else `allowed`). */
export function refuseUnknown(
	entry: Record<string, unknown>,
	allowed: readonly string[],
	name: string,
	shown: readonly string[] = allowed,
): void {
	const unknown = Object.keys(entry).filter((key) => !allowed.includes(key));
	if (unknown.length)
		throw new Error(`Unknown ${name} fields: ${unknown.join(", ")}. An entry takes ${shown.join(", ")}.`);
}

/**
 * `edit` with several `items`: each entry is a full single edit (`one`), applied in order with every store check. A
 * refused entry is reported on its own line, labelled by its id, and the rest still apply.
 */
export function batchUpdate(
	entries: readonly Record<string, unknown>[],
	allowed: readonly string[],
	name: string,
	one: (entry: Record<string, unknown>) => Result,
	shown?: readonly string[],
): Batch {
	const rows = entries.map((entry, index) => {
		const label = typeof entry.id === "string" && entry.id.trim() ? entry.id : `${name}[${index}]`;
		return attempt(label, () => {
			refuseUnknown(entry, allowed, name, shown);
			return one(entry);
		});
	});
	return summary("Updated", rows);
}

/** Rewrites each `dependsOn` value that is the exact title of an earlier entry of the same add, and not an item id, to that entry's ref. */
type EarlierTitles = <T extends { dependsOn?: readonly unknown[] }>(params: T) => T;

/**
 * `add` with several `items`: each entry is a full single add (`one`), applied in order with every store check. A
 * refused entry is reported on its own line, labelled by its title, and the rest still apply. A later entry's
 * `dependsOn` may name an earlier added entry by its exact title (`one` applies `earlier`), so one add can carry a
 * whole graph: the refs are given on insert and cannot be named in advance.
 */
export function batchAdd(
	entries: readonly Record<string, unknown>[],
	allowed: readonly string[],
	name: string,
	one: (entry: Record<string, unknown>, earlier: EarlierTitles) => Result,
	shown?: readonly string[],
): Batch {
	const added = new Map<string, string>();
	// A value that reads as an item id (`B2`, `#2`, `2`) names that item, even when an earlier entry is titled so.
	const titleRef = (ref: unknown) =>
		typeof ref === "string" && parseRef(ref) === undefined ? (added.get(ref.trim()) ?? ref) : ref;
	const earlier: EarlierTitles = (params) =>
		params.dependsOn ? { ...params, dependsOn: params.dependsOn.map(titleRef) } : params;
	const rows = entries.map((entry, index) => {
		const named = [entry.title, entry.goal].find((v): v is string => typeof v === "string" && v.trim() !== "");
		return attempt(named ? `"${named.trim().slice(0, 60)}"` : `${name}[${index}]`, () => {
			refuseUnknown(entry, allowed, name, shown);
			const result = one(entry, earlier);
			const item = (result.details as { item?: { ref?: unknown; title?: unknown } } | undefined)?.item;
			if (typeof item?.ref === "string" && typeof item.title === "string" && !added.has(item.title.trim()))
				added.set(item.title.trim(), item.ref);
			return result;
		});
	});
	return summary("Added", rows);
}
