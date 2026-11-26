import { textResult } from "../shared/util.ts";
import {
	appendWrite,
	attemptWrite,
	batchSummary,
	type BatchResult as Batch,
	type EntryOutcome,
	type EntryResult as Result,
} from "../shared/batch.ts";
import { parseRef } from "./item.ts";

/** `get` with several comma-separated ids: each item's record, or its own error row (unknown id). */
export async function batchGet(
	ids: readonly string[],
	one: (id: string) => Result | Promise<Result>,
	signal?: AbortSignal,
): Promise<Batch> {
	const rows: EntryOutcome[] = [];
	for (const id of ids) rows.push(await attemptWrite(id, () => one(id), signal));
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
export async function batchUpdate(
	entries: readonly Record<string, unknown>[],
	allowed: readonly string[],
	name: string,
	one: (entry: Record<string, unknown>, index: number) => Result | Promise<Result>,
	shown?: readonly string[],
	signal?: AbortSignal,
	/** What the batch does, for its receipt and head line: `done` and `Done`, not the generic `edit` and `Updated`. */
	words: { operation: string; verb: string } = { operation: "edit", verb: "Updated" },
): Promise<Batch> {
	const rows: EntryOutcome[] = [];
	for (const [index, entry] of entries.entries()) {
		const label = typeof entry.id === "string" && entry.id.trim() ? entry.id : `${name}[${index}]`;
		await appendWrite(
			rows,
			words.operation,
			entries.length,
			label,
			() => {
				refuseUnknown(entry, allowed, name, shown);
				return one(entry, index);
			},
			signal,
		);
	}
	return batchSummary(words.verb, rows);
}

/**
 * Rewrites each `dependsOn` value and the `parentId` that is the exact title of an earlier entry of the same add, and
 * not an item id, to that entry's ref.
 */
type EarlierTitles = <T extends { dependsOn?: readonly unknown[]; parentId?: unknown }>(params: T) => T;

/**
 * `add` with several `items`: each entry is a full single add (`one`), applied in order with every store check. A
 * refused entry is reported on its own line, labelled by its title, and the rest still apply. A later entry's
 * `dependsOn` and `parentId` may name an earlier added entry by its exact title (`one` applies `earlier`), so one add
 * can carry a whole graph with its epic: the refs are given on insert and cannot be named in advance.
 */
export async function batchAdd(
	entries: readonly Record<string, unknown>[],
	allowed: readonly string[],
	name: string,
	one: (entry: Record<string, unknown>, earlier: EarlierTitles) => Result | Promise<Result>,
	shown?: readonly string[],
	signal?: AbortSignal,
): Promise<Batch> {
	const added = new Map<string, string>();
	// A value that reads as an item id (`B2`, `#2`, `2`) names that item, even when an earlier entry is titled so.
	const titleRef = (ref: unknown) =>
		typeof ref === "string" && parseRef(ref) === undefined ? (added.get(ref.trim()) ?? ref) : ref;
	const earlier: EarlierTitles = (params) => ({
		...params,
		...(params.dependsOn ? { dependsOn: params.dependsOn.map(titleRef) } : {}),
		...(typeof params.parentId === "string" ? { parentId: titleRef(params.parentId) } : {}),
	});
	const rows: EntryOutcome[] = [];
	for (const [index, entry] of entries.entries()) {
		const named = [entry.title, entry.goal].find((v): v is string => typeof v === "string" && v.trim() !== "");
		await appendWrite(
			rows,
			"add",
			entries.length,
			named ? `"${named.trim().slice(0, 60)}"` : `${name}[${index}]`,
			async () => {
				refuseUnknown(entry, allowed, name, shown);
				const result = await one(entry, earlier);
				const item = (result.details as { item?: { ref?: unknown; title?: unknown } } | undefined)?.item;
				if (typeof item?.ref === "string" && typeof item.title === "string" && !added.has(item.title.trim()))
					added.set(item.title.trim(), item.ref);
				return result;
			},
			signal,
		);
	}
	return batchSummary("Added", rows);
}
