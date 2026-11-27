/**
 * The backlog items queued children will start, by the child's name. A chain queue publishes itself here while it has
 * children waiting, so the board snapshot (`backlogSnapshot`) can say `queuedBy` without importing the subagents domain.
 */
const sources = new Set<() => ReadonlyMap<string, string>>();

/** Publishes `source` (item ref -> child name) until the returned function is called. */
export function publishQueuedItems(source: () => ReadonlyMap<string, string>): () => void {
	sources.add(source);
	return () => void sources.delete(source);
}

/** Every item a queued child of this process waits to start, with that child's name. */
export function queuedItems(): ReadonlyMap<string, string> {
	const merged = new Map<string, string>();
	for (const source of sources) for (const [ref, name] of source()) merged.set(ref, name);
	return merged;
}
