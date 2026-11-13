/** What reading a session's entries in file order needs from a session manager; only `getEntries` is required. */
export interface EntrySource {
	getEntries?(): readonly unknown[];
	getEntryCount?(): number;
	getEntry?(id: string): unknown;
	getLeafId?(): string | null;
	getHeader?(): unknown;
}

/** The entries a read adds: the whole session when `restart` (the fold starts over), else only those appended since. */
export interface AppendedEntries {
	restart: boolean;
	entries: readonly unknown[];
}

/** Where the last read ended: the session and its header, its first and last entries, how many there were. */
interface Mark {
	session: object;
	header: unknown;
	first: unknown;
	tail: unknown;
	length: number;
	/** `getEntryCount()` at the same moment, when the session has it. */
	count: number | undefined;
}

/**
 * A cursor over a session's entries in file order (`getEntries`), so a fold that runs after every reply reads only the
 * entries appended since its last read. Appends go at the end of the file and each is a child of the leaf, so the new
 * entries are usually the path from the leaf up to the last entry read, which the session's own index walks in O(new
 * entries) with no copy of the session; the entry count proves the path holds every entry added. Anything else (another
 * session, another header, a branch appended elsewhere, entries merged from another process, a rolled-back append)
 * falls back to `getEntries()`: its prefix still ends with the entries read last, or the read restarts from the start.
 */
export class EntryCursor {
	private mark: Mark | undefined;

	/** Forgets the position: the next read returns every entry with `restart`. */
	reset(): void {
		this.mark = undefined;
	}

	next(session: EntrySource): AppendedEntries {
		const header = session.getHeader?.();
		const known = this.mark?.session === session && this.mark.header === header ? this.mark : undefined;
		this.mark = undefined;
		const added = known && walk(session, known);
		if (known && added) {
			const count = known.count! + added.length;
			if (added.length > 0)
				this.mark = { ...known, tail: added[added.length - 1], length: known.length + added.length, count };
			else this.mark = known;
			return { restart: false, entries: added };
		}
		const entries = session.getEntries?.() ?? [];
		const resumes =
			known !== undefined &&
			known.length > 0 &&
			entries.length >= known.length &&
			sameEntry(entries[0], known.first) &&
			sameEntry(entries[known.length - 1], known.tail);
		if (entries.length > 0)
			this.mark = {
				session,
				header,
				first: entries[0],
				tail: entries[entries.length - 1],
				length: entries.length,
				count: session.getEntryCount?.(),
			};
		return resumes ? { restart: false, entries: entries.slice(known.length) } : { restart: true, entries };
	}
}

/**
 * The entries appended since `mark` when they are exactly the leaf's ancestors below the last entry read, oldest
 * first; undefined when that cannot be proven (then the caller reads the whole list). Visits at most the new entries.
 */
function walk(session: EntrySource, mark: Mark): unknown[] | undefined {
	if (!session.getEntryCount || !session.getEntry || !session.getLeafId || mark.count === undefined) return undefined;
	const tail = idOf(mark.tail);
	const first = idOf(mark.first);
	if (tail === undefined || first === undefined) return undefined;
	// The entries read are still the session's (a rolled-back or replaced entry would not be).
	if (session.getEntry(tail) !== mark.tail || session.getEntry(first) !== mark.first) return undefined;
	const wanted = session.getEntryCount() - mark.count;
	if (wanted < 0) return undefined;
	// No entry added (the leaf may have moved to an older entry, which appends nothing).
	if (wanted === 0) return [];
	const added: unknown[] = [];
	let id = session.getLeafId();
	while (id !== tail) {
		if (!id || added.length === wanted) return undefined;
		const entry = session.getEntry(id);
		if (idOf(entry) !== id) return undefined;
		added.push(entry);
		const parent = (entry as { parentId?: unknown }).parentId;
		id = typeof parent === "string" ? parent : null;
	}
	return added.length === wanted ? added.reverse() : undefined;
}

function idOf(entry: unknown): string | undefined {
	const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
	return typeof id === "string" ? id : undefined;
}

/** The same entry: the same object, or (a session that copies its entries) the same id. */
function sameEntry(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const id = idOf(a);
	return id !== undefined && id === idOf(b);
}
