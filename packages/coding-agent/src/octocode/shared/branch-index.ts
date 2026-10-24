/** What reading a branch needs from a session manager. */
export interface BranchSource {
	getBranch(): readonly unknown[];
	getLeafId?(): string | null;
	getEntry?(id: string): unknown;
}

/** How far a session's fold has read: the branch length, the id of its last entry (the proof it is the same branch), and the state. */
interface Cursor<S> {
	length: number;
	tail: string;
	state: S;
}

/**
 * A fold over a session branch that a request resumes instead of repeating. A branch only grows at its end (Octocode's entries
 * are immutable and their ids unique, so a branch whose entry at the old length has the old last id begins with the same
 * entries), so a read visits only the entries added since the last one. A branch that does not continue the last one (another
 * leaf, a compaction that moved the path) or whose entries have no ids is folded again from its start. Per session manager.
 *
 * `visit` adds one entry to the state and must not throw (a visit that does drops the cursor, so the next read starts over).
 * The state is shared between reads: a caller treats it as read-only.
 */
export class BranchIndex<S> {
	private readonly cursors = new WeakMap<object, Cursor<S>>();

	private readonly start: () => S;
	private readonly visit: (state: S, entry: unknown) => void;
	constructor(start: () => S, visit: (state: S, entry: unknown) => void) {
		this.start = start;
		this.visit = visit;
	}

	/** Native sessions walk only new ancestors; adapters without entry lookup use the branch-array fallback. */
	read(session: BranchSource): S {
		const known = this.cursors.get(session);
		if (known && this.resume(session, known)) return known.state;
		const branch = session.getBranch();
		const resumes =
			known !== undefined && branch.length >= known.length && idOf(branch[known.length - 1]) === known.tail;
		const cursor = resumes ? known : { length: 0, tail: "", state: this.start() };
		this.cursors.delete(session);
		for (let index = cursor.length; index < branch.length; index++) this.visit(cursor.state, branch[index]);
		const tail = idOf(branch[branch.length - 1]);
		if (tail !== undefined) this.cursors.set(session, { length: branch.length, tail, state: cursor.state });
		return cursor.state;
	}

	private resume(session: BranchSource, cursor: Cursor<S>): boolean {
		if (!session.getEntry || !session.getLeafId) return false;
		const leaf = session.getLeafId();
		if (leaf === cursor.tail) return true;
		const added: unknown[] = [];
		const seen = new Set<string>();
		let id: string | null | undefined = leaf;
		while (id !== cursor.tail) {
			if (!id || seen.has(id)) return false;
			seen.add(id);
			const entry = session.getEntry(id);
			if (idOf(entry) !== id) return false;
			added.push(entry);
			const parent = (entry as { parentId?: unknown }).parentId;
			id = typeof parent === "string" ? parent : undefined;
		}
		this.cursors.delete(session);
		for (const entry of added.reverse()) this.visit(cursor.state, entry);
		this.cursors.set(session, { length: cursor.length + added.length, tail: leaf!, state: cursor.state });
		return true;
	}
}

function idOf(entry: unknown): string | undefined {
	const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
	return typeof id === "string" ? id : undefined;
}
