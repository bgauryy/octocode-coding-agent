import type { SessionEntry } from "./types.ts";

interface ParentLinked {
	id: string;
	parentId: string | null;
}

/**
 * Yields `start`, then each ancestor, nearest first. The walk ends at a root, at a parent `lookup` cannot find,
 * or before an entry it already yielded: a damaged or hand-edited session file can name an entry as its own
 * parent or close a loop of parent links, and the entry that closes the loop then acts as the root.
 */
export function* ancestors<T extends ParentLinked>(
	start: T | undefined,
	lookup: (id: string) => T | undefined,
): Generator<T, void, undefined> {
	const seen = new Set<string>();
	for (let current = start; current && !seen.has(current.id);) {
		seen.add(current.id);
		yield current;
		current = current.parentId ? lookup(current.parentId) : undefined;
	}
}

/** The root-first path that ends at `start`; `ancestors` says where the walk stops. */
export function pathFromRoot<T extends ParentLinked>(start: T | undefined, lookup: (id: string) => T | undefined): T[] {
	// The same walk as `ancestors`, without a generator: this runs for the whole branch on most session reads.
	const path: T[] = [];
	const seen = new Set<string>();
	for (let current = start; current && !seen.has(current.id);) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? lookup(current.parentId) : undefined;
	}
	return path.reverse();
}

export function* newestFirst(entries: readonly SessionEntry[]): Generator<SessionEntry, void, undefined> {
	for (let i = entries.length - 1; i >= 0; i--) yield entries[i];
}

/** A receipt or planned summary still describes the context through `lastEntryId` when that prefix is on this branch
 * and has not been compacted or edited. Edits to later messages (including an omitted retry) affect only the suffix. */
export function hasUnchangedContextPrefix(newestFirst: Iterable<SessionEntry>, lastEntryId: string): boolean {
	let edited: Set<string> | undefined;
	for (const entry of newestFirst) {
		if (entry.id === lastEntryId) return !edited?.size;
		if (entry.type === "compaction") return false;
		if (entry.type === "context_edit") (edited ??= new Set()).add(entry.targetId);
		edited?.delete(entry.id);
	}
	return false;
}
