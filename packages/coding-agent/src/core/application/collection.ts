/** Immutable map updates with one copy for an explicitly batched hydration or reprojection. */
export class ApplicationCollection<T> {
	private draft?: Map<string, T>;
	private batching = false;
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
		const next = this.draft ?? new Map(this.values);
		next.set(id, value);
		if (this.batching) this.draft = next;
		else this.write(next);
	}
	clear(): void {
		this.draft = undefined;
		this.write(new Map());
	}
	batch(work: () => void): void {
		if (this.batching) return work();
		this.batching = true;
		try {
			work();
		} finally {
			const draft = this.draft;
			this.draft = undefined;
			this.batching = false;
			if (draft) this.write(draft);
		}
	}
}
