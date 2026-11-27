import { pathFromRoot } from "./ancestors.ts";
import type { SessionEntry } from "./types.ts";

/**
 * A session's entries by id, which also knows when an id it held was replaced or removed. Appending a new id leaves
 * every existing root-to-entry path as it was; a replacement, a removal or a rebuild can change them, and `rewrites`
 * counts those so `branchPath` knows when the path it kept is no longer safe to extend. `added` counts the entries set
 * under a new id, and `addedAt` numbers each of them, so a reader can tell the entries added since it last looked.
 */
export class EntryIndex extends Map<string, SessionEntry> {
	rewrites = 0;
	added = 0;
	// Created on first use: Map's constructor runs `set` for its initial entries before fields exist. An entry without a
	// number counts as not added, which only makes `branchPath` walk.
	private ordinals: WeakMap<SessionEntry, number> | undefined;

	override set(id: string, entry: SessionEntry): this {
		const held = this.get(id);
		if (held !== undefined && held !== entry) this.rewrites++;
		else if (held === undefined) (this.ordinals ??= new WeakMap()).set(entry, this.added++);
		return super.set(id, entry);
	}

	/** The number of entries added before `entry` was set under a new id; undefined for an entry this index did not add. */
	addedAt(entry: SessionEntry): number | undefined {
		return this.ordinals?.get(entry);
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

const lastPath = new WeakMap<EntryIndex, { rewrites: number; added: number; path: SessionEntry[] }>();

/**
 * The entries from the kept path's tail (exclusive) to `leaf`, root first, when `leaf` descends from the tail only
 * through entries the index added since the path was kept; undefined otherwise. At most the number added are walked.
 */
function addedSince(
	index: EntryIndex,
	known: { added: number; path: SessionEntry[] },
	leaf: SessionEntry,
): SessionEntry[] | undefined {
	const tail = known.path.at(-1);
	const chain: SessionEntry[] = [];
	for (let entry: SessionEntry | undefined = leaf; entry !== tail;) {
		const at = entry && index.get(entry.id) === entry ? index.addedAt(entry) : undefined;
		if (!entry || at === undefined || at < known.added || chain.length >= index.added - known.added) return undefined;
		chain.push(entry);
		entry = entry.parentId ? index.get(entry.parentId) : undefined;
	}
	return chain.reverse();
}

/**
 * The root-first path that ends at `leaf` (`pathFromRoot`). Most session reads ask for the path of the current leaf,
 * and the next leaf usually descends from the last one through the entries appended since, so the last path is kept
 * per index: asked again it is copied, asked for a leaf below its tail through newly added entries it is extended by
 * them, and anything else walks the tree. Walking the whole branch for each read made a turn cost more the longer the
 * session was. The caller gets its own array.
 */
export function branchPath(index: Map<string, SessionEntry>, leaf: SessionEntry | undefined): SessionEntry[] {
	if (!(index instanceof EntryIndex) || !leaf) return pathFromRoot(leaf, (id) => index.get(id));
	const known = lastPath.get(index);
	if (known && known.rewrites === index.rewrites) {
		if (known.path.at(-1) === leaf) return known.path.slice();
		const chain = addedSince(index, known, leaf);
		if (chain) {
			// The kept path is never handed out, so it grows in place.
			known.path.push(...chain);
			known.added = index.added;
			return known.path.slice();
		}
	}
	const path = pathFromRoot(leaf, (id) => index.get(id));
	lastPath.set(index, { rewrites: index.rewrites, added: index.added, path });
	return path.slice();
}
