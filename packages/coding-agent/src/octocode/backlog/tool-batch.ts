import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { contentText, textResult } from "../shared/util.ts";
import { parseRef } from "./item.ts";
import { BacklogBatchAbortedError, type BatchOutcome } from "./batch-outcome.ts";

type Result = { content: unknown; details?: unknown };
type Batch = ReturnType<typeof textResult>;
type EntryOutcome = { ok: boolean; text: string };

async function attemptWrite(label: string, run: () => Result | Promise<Result>, signal?: AbortSignal) {
	try {
		signal?.throwIfAborted();
		return { ok: true, text: contentText((await run()).content) };
	} catch (error) {
		signal?.throwIfAborted();
		return { ok: false, text: `${visibleControls(label)}: refused - ${errorMessage(error)}` };
	}
}

async function appendWrite(
	rows: EntryOutcome[],
	operation: "add" | "edit",
	requested: number,
	label: string,
	run: () => Result | Promise<Result>,
	signal?: AbortSignal,
): Promise<void> {
	let started = false;
	try {
		rows.push(
			await attemptWrite(
				label,
				() => {
					started = true;
					return run();
				},
				signal,
			),
		);
	} catch (error) {
		if (!signal?.aborted || (!rows.length && !started)) throw error;
		const outcomes: BatchOutcome[] = rows.map((row, index) => ({
			index,
			status: row.ok ? "applied" : "refused",
			text: row.text,
		}));
		if (started)
			outcomes.push({
				index: rows.length,
				status: "unknown",
				text: `${visibleControls(label)}: outcome unknown; inspect stored state before retrying.`,
			});
		throw new BacklogBatchAbortedError(operation, requested, outcomes);
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
	one: (entry: Record<string, unknown>) => Result | Promise<Result>,
	shown?: readonly string[],
	signal?: AbortSignal,
): Promise<Batch> {
	const rows: EntryOutcome[] = [];
	for (const [index, entry] of entries.entries()) {
		const label = typeof entry.id === "string" && entry.id.trim() ? entry.id : `${name}[${index}]`;
		await appendWrite(
			rows,
			"edit",
			entries.length,
			label,
			() => {
				refuseUnknown(entry, allowed, name, shown);
				return one(entry);
			},
			signal,
		);
	}
	return summary("Updated", rows);
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
	return summary("Added", rows);
}
