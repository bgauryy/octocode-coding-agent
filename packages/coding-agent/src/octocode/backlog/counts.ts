import { STATES, type State, deriveEpicState } from "@octocodeai/octocode-contracts/snapshot";

/**
 * What the footer and the board count, from one place. Epics are not items to work on: they are counted once, in `epics`,
 * by the state their children give them (`deriveEpicState`); every other item is counted in `items` by its own state.
 * A closed item is not done: every closed item or epic is counted in `closed` only.
 */
export interface BacklogCounts {
	items: Record<State, number>;
	epics: Record<State, number>;
	closed: number;
}

/** The least `summarizeCounts` reads of an item; `key` and `parent` name the same thing (a ref, or a row id) across items. */
export interface CountEntry {
	key: string;
	type: string;
	state: State;
	/** Closed instead of done (stored as done). */
	closed?: boolean;
	parent?: string;
}

const zero = (): Record<State, number> =>
	Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;

const noCounts = (): BacklogCounts => ({ items: zero(), epics: zero(), closed: 0 });

export const openEpics = (counts: BacklogCounts): number =>
	counts.epics.backlog + counts.epics.todo + counts.epics.ongoing;

/** Counts `entries`: items by state, epics by the state derived from the entries whose `parent` is the epic's `key`. */
export function summarizeCounts(entries: readonly CountEntry[]): BacklogCounts {
	const counts = noCounts();
	const children = new Map<string, State[]>();
	for (const entry of entries)
		if (entry.parent !== undefined) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.state]);
	for (const entry of entries) {
		if (entry.closed) counts.closed += 1;
		else if (entry.type === "epic") counts.epics[deriveEpicState(entry.state, children.get(entry.key) ?? [])] += 1;
		else counts.items[entry.state] += 1;
	}
	return counts;
}
