/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores detached copies of state snapshots, made by `detach` (a deep `structuredClone` by default). Popped
 * snapshots are returned directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/**
	 * @param detach Copies a snapshot so later edits to the live state cannot reach it. Strings are immutable, so a
	 *   state made of strings can copy only its containers and share the text, which keeps a large paste from being
	 *   copied once per undo step.
	 */
	constructor(detach: (state: S) => S = structuredClone) {
		this.detach = detach;
	}

	private readonly detach: (state: S) => S;

	/** Push a detached copy of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.detach(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
