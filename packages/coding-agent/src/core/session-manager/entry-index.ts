import { pathFromRoot } from "./ancestors.ts";
import type { SessionEntry } from "./types.ts";

/**
 * A session's entries by id, which also knows when an id it held was replaced or removed. Appending a new id leaves
 * every existing root-to-entry path as it was; a replacement, a removal or a rebuild can change them, and `rewrites`
 * counts those so `branchPath` knows when the path it kept is no longer safe to extend.
 */
export class EntryIndex extends Map<string, SessionEntry> {
	rewrites = 0;

	override set(id: string, entry: SessionEntry): this {
		const held = this.get(id);
		if (held !== undefined && held !== entry) this.rewrites++;
		return super.set(id, entry);
	}

	override delete(id: string): boolean {
		const removed = super.delete(id);
		if (removed) this.rewrites++;
		return removed;
	}

	override clear(): void {
		this.rewrites++;
		super.clear();
	}
}

const lastPath = new WeakMap<EntryIndex, { rewrites: number; path: SessionEntry[] }>();

/**
 * The root-first path that ends at `leaf` (`pathFromRoot`). Most session reads ask for the path of the current leaf,
 * and the next leaf is usually a child of the last one, so the last path is kept per index: asked again it is copied,
 * asked for its tail's child it is extended by one entry, and anything else walks the tree. Walking the whole branch
 * for each read made a turn cost more the longer the session was. The caller gets its own array.
 */
export function branchPath(index: Map<string, SessionEntry>, leaf: SessionEntry | undefined): SessionEntry[] {
	if (!(index instanceof EntryIndex) || !leaf) return pathFromRoot(leaf, (id) => index.get(id));
	const known = lastPath.get(index);
	if (known && known.rewrites === index.rewrites) {
		const tail = known.path.at(-1);
		if (tail === leaf) return known.path.slice();
		// A child of the kept tail, held by the index as that very entry.
		if (tail && leaf.parentId === tail.id && index.get(leaf.id) === leaf) {
			const path = [...known.path, leaf];
			lastPath.set(index, { rewrites: index.rewrites, path });
			return path.slice();
		}
	}
	const path = pathFromRoot(leaf, (id) => index.get(id));
	lastPath.set(index, { rewrites: index.rewrites, path });
	return path.slice();
}
