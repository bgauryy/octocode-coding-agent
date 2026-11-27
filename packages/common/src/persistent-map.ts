const BITS = 5;
const WIDTH = 1 << BITS;
const MASK = WIDTH - 1;

/** A trie node: leaves hold values, inner nodes hold nodes. */
type Node = unknown[];

/** Keys in insertion order and each key's position, shared by every version that extends the same tip. */
interface Lineage {
	readonly keys: string[];
	readonly index: Map<string, number>;
}

/**
 * An immutable, insertion-ordered string map whose `set` copies one path of a 32-way trie (a few dozen slots) rather
 * than the whole map, so a version kept by a reader never changes and a new version costs O(log n). Replacing a key keeps
 * its position, as `Map` does; there is no delete (a cleared collection starts a new map).
 *
 * Versions share their key list while each new key is appended at the newest version; a key added to an older version
 * copies the list first, so no version ever sees a key it did not have. `owned` lets one batch reuse the nodes it
 * created itself instead of copying them again (`ApplicationCollection.batch`); nodes another version holds are always
 * copied.
 */
export class PersistentMap<T> implements ReadonlyMap<string, T> {
	readonly size: number;
	private readonly lineage: Lineage;
	private readonly root: Node;
	private readonly shift: number;
	private constructor(lineage: Lineage, root: Node, shift: number, size: number) {
		this.lineage = lineage;
		this.root = root;
		this.shift = shift;
		this.size = size;
	}

	static empty<T>(): PersistentMap<T> {
		return new PersistentMap<T>({ keys: [], index: new Map() }, [], 0, 0);
	}

	/** The same entries as `values`, in its order. */
	static from<T>(values: ReadonlyMap<string, T>): PersistentMap<T> {
		if (values instanceof PersistentMap) return values as PersistentMap<T>;
		const owned = new Set<Node>();
		let map = PersistentMap.empty<T>();
		for (const [key, value] of values) map = map.set(key, value, owned);
		return map;
	}

	private position(key: string): number | undefined {
		const at = this.lineage.index.get(key);
		return at !== undefined && at < this.size ? at : undefined;
	}

	private at(position: number): T {
		let node = this.root;
		for (let level = this.shift; level > 0; level -= BITS) node = node[(position >>> level) & MASK] as Node;
		return node[position & MASK] as T;
	}

	get(key: string): T | undefined {
		const at = this.position(key);
		return at === undefined ? undefined : this.at(at);
	}

	has(key: string): boolean {
		return this.position(key) !== undefined;
	}

	/** A new version with `key` set to `value`; this one is unchanged. */
	set(key: string, value: T, owned?: Set<Node>): PersistentMap<T> {
		let position = this.position(key);
		let lineage = this.lineage;
		if (position === undefined) {
			position = this.size;
			if (lineage.keys.length !== this.size) {
				const keys = lineage.keys.slice(0, this.size);
				lineage = { keys, index: new Map(keys.map((name, at) => [name, at])) };
			}
			lineage.keys.push(key);
			lineage.index.set(key, position);
		}
		let root = this.root;
		let shift = this.shift;
		if (position >= 1 << (shift + BITS)) {
			root = [root];
			owned?.add(root);
			shift += BITS;
		}
		root = assoc(root, shift, position, value, owned);
		return new PersistentMap<T>(lineage, root, shift, Math.max(this.size, position + 1));
	}

	*keys(): MapIterator<string> {
		for (let at = 0; at < this.size; at++) yield this.lineage.keys[at];
	}

	values(): MapIterator<T> {
		return this.valuesFrom(0);
	}

	/** Values in insertion order starting at an index, without visiting the preceding entries. */
	*valuesFrom(start: number): MapIterator<T> {
		for (let at = Math.max(0, Math.trunc(start)); at < this.size; at++) yield this.at(at);
	}

	*entries(): MapIterator<[string, T]> {
		for (let at = 0; at < this.size; at++) yield [this.lineage.keys[at], this.at(at)];
	}

	[Symbol.iterator](): MapIterator<[string, T]> {
		return this.entries();
	}

	forEach(callback: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown): void {
		for (let at = 0; at < this.size; at++) callback.call(thisArg, this.at(at), this.lineage.keys[at], this);
	}

	get [Symbol.toStringTag](): string {
		return "PersistentMap";
	}
}

/** `node` with `value` at `position`: a copy of each node on the path, unless the batch (`owned`) created it. */
function assoc(node: Node | undefined, level: number, position: number, value: unknown, owned?: Set<Node>): Node {
	let copy: Node;
	if (node && owned?.has(node)) copy = node;
	else {
		copy = node ? node.slice() : [];
		owned?.add(copy);
	}
	if (level === 0) copy[position & MASK] = value;
	else {
		const slot = (position >>> level) & MASK;
		copy[slot] = assoc(copy[slot] as Node | undefined, level - BITS, position, value, owned);
	}
	return copy;
}
