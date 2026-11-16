import { PersistentMap } from "@octocodeai/octocode-common/persistent-map";

/**
 * Immutable map updates: each `set` publishes a new version (`PersistentMap`, a path copy rather than a whole-map copy,
 * so a streamed delta costs the same at 70 messages as at 3,500), and a batch publishes once at its end. A version a
 * reader holds never changes.
 */
export class ApplicationCollection<T> {
	private draft?: PersistentMap<T>;
	/** Nodes the running batch created, which it may change in place: nothing outside the batch has seen them. */
	private owned?: Set<unknown[]>;
	private readonly read: () => ReadonlyMap<string, T>;
	private readonly write: (values: ReadonlyMap<string, T>) => void;
	constructor(read: () => ReadonlyMap<string, T>, write: (values: ReadonlyMap<string, T>) => void) {
		this.read = read;
		this.write = write;
	}
	get values(): ReadonlyMap<string, T> {
		return this.draft ?? this.read();
	}
	set(id: string, value: T): void {
		// A store reset elsewhere leaves a plain map: it is taken over once, then extended.
		const next = (this.draft ?? PersistentMap.from(this.read())).set(id, value, this.owned);
		if (this.owned) this.draft = next;
		else this.write(next);
	}
	clear(): void {
		this.draft = undefined;
		if (this.owned) this.owned = new Set();
		this.write(PersistentMap.empty());
	}
	batch(work: () => void): void {
		if (this.owned) return work();
		this.owned = new Set();
		try {
			work();
		} finally {
			const draft = this.draft;
			this.draft = undefined;
			this.owned = undefined;
			if (draft) this.write(draft);
		}
	}
}
