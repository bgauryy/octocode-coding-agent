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
	return [...ancestors(start, lookup)].reverse();
}
