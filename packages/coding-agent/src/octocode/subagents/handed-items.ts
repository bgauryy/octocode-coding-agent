/**
 * The items handed to each running child after its start, with how to take each back: `end` runs when the child's run
 * ends (`claim.ts`), so the child's grant lasts exactly as long as the run.
 */
export class HandedItems {
	private readonly byChild = new Map<string, Map<string, () => void>>();

	add(child: string, ref: string, revoke: () => void): void {
		const items = this.byChild.get(child) ?? new Map<string, () => void>();
		items.set(ref, revoke);
		this.byChild.set(child, items);
	}

	has(child: string, ref: string): boolean {
		return this.byChild.get(child)?.has(ref) ?? false;
	}

	/** Every child and an item handed to it. */
	*pairs(): IterableIterator<[string, string]> {
		for (const [child, items] of this.byChild) for (const ref of items.keys()) yield [child, ref];
	}

	/** Takes back one item, or, without `ref`, every item of `child`. */
	end(child: string, ref?: string): void {
		const items = this.byChild.get(child);
		if (!items) return;
		for (const [each, revoke] of items) if (ref === undefined || each === ref) revoke();
		if (ref === undefined) this.byChild.delete(child);
		else items.delete(ref);
	}
}

/** The run state `servedItems` reads (`AgentRuns`, which this leaf cannot import). */
interface ServedRuns {
	running: { has(id: string): boolean };
	items: ReadonlyMap<string, string>;
	handed?: HandedItems;
}

/** Each running child with an item it works on: the one it was started for and those handed to it since. */
export function* servedItems(runs: ServedRuns): IterableIterator<[string, string]> {
	for (const [child, ref] of runs.items) if (runs.running.has(child)) yield [child, ref];
	for (const [child, ref] of runs.handed?.pairs() ?? []) if (runs.running.has(child)) yield [child, ref];
}
