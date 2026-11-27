import * as appends from "./appends.ts";
import {
	extendedProjection,
	extendProjection,
	type ProjectionParts,
	projectionOf,
	projectionParts,
} from "./context.ts";
import { branchPath, EntryIndex } from "./entry-index.ts";
import { createSessionState, type SessionState } from "./state.ts";
import type { FileEntry, ReadonlySessionProjection, SessionEntry, SessionProjection } from "./types.ts";

/**
 * The projection of a session's leaf, kept between reads. A turn reads it many times (each request, the usage samples,
 * the compaction checks, the turn boundaries), and building it from the whole branch each time made a turn cost more
 * the longer the session was.
 *
 * Kept with the index generation (`EntryIndex.rewrites`), the entry list and its length, and the leaf. It holds while
 * the index was only added to and the entry list only grew: the leaf unchanged, the kept projection is the answer; a
 * leaf reached from the kept one through entries added since (an append, a turn's messages, a boundary's drafts), the
 * projection is extended by them. Anything else, or an added compaction, builds it again from the branch: a replaced or
 * removed entry, a reload, another branch, a leaf among older entries.
 */
interface Memo {
	parts: ProjectionParts;
	leaf: SessionEntry;
	rewrites: number;
	fileEntries: FileEntry[];
	length: number;
}

const memos = new WeakMap<SessionState, Memo>();

const emptyParts = (): ProjectionParts => projectionParts([]);

/**
 * The entries from `memo.leaf` (exclusive) to `leaf`, root first, when `leaf` descends from it only through entries the
 * list gained since: undefined otherwise.
 */
function addedChain(memo: Memo, leaf: SessionEntry, state: SessionState): SessionEntry[] | undefined {
	const added = new Set<FileEntry>();
	for (let i = memo.length; i < state.fileEntries.length; i++) added.add(state.fileEntries[i]);
	const chain: SessionEntry[] = [];
	for (let entry: SessionEntry | undefined = leaf; entry !== memo.leaf;) {
		if (!entry || !added.has(entry) || chain.length >= added.size) return undefined;
		chain.push(entry);
		entry = entry.parentId ? state.byId.get(entry.parentId) : undefined;
	}
	return chain.reverse();
}

/** The leaf a read uses when the leaf id names no entry: the last entry, as `buildSessionProjection` does. */
function lastEntry(state: SessionState): SessionEntry | undefined {
	for (let i = state.fileEntries.length - 1; i >= 0; i--) {
		const entry = state.fileEntries[i];
		if (entry.type !== "session") return entry;
	}
	return undefined;
}

/**
 * The projection parts at the state's leaf: kept (shared with later reads, never handed out as they are) when the leaf is
 * an indexed entry, else built for this read.
 */
function leafParts(state: SessionState): ProjectionParts {
	if (state.leafId === null) return emptyParts();
	const index = state.byId;
	const leaf = index.get(state.leafId);
	if (!leaf || !(index instanceof EntryIndex)) return projectionParts(branchPath(index, leaf ?? lastEntry(state)));
	const memo = memos.get(state);
	if (
		memo &&
		memo.rewrites === index.rewrites &&
		memo.fileEntries === state.fileEntries &&
		state.fileEntries.length >= memo.length
	) {
		if (memo.leaf === leaf) return memo.parts;
		const chain = addedChain(memo, leaf, state);
		if (chain && extendProjection(memo.parts, chain)) {
			memo.leaf = leaf;
			memo.length = state.fileEntries.length;
			return memo.parts;
		}
	}
	const parts = projectionParts(branchPath(index, leaf));
	memos.set(state, {
		parts,
		leaf,
		rewrites: index.rewrites,
		fileEntries: state.fileEntries,
		length: state.fileEntries.length,
	});
	return parts;
}

/** `buildSessionProjection` at the state's leaf, in arrays of the caller's own. */
export function leafProjection(state: SessionState): SessionProjection {
	return projectionOf(leafParts(state), true);
}

/**
 * `buildSessionProjection` at the state's leaf without copying: the kept arrays themselves, which the session's next
 * change may extend or replace. Read it before then; copy what is kept longer.
 */
export function leafProjectionView(state: SessionState): ReadonlySessionProjection {
	return projectionOf(leafParts(state), false);
}

/** `buildContextEntries` at the state's leaf, in an array of the caller's own. */
export function leafContextEntries(state: SessionState): SessionEntry[] {
	return leafParts(state).contextEntries.slice();
}

/** What a boundary may append before it commits (`SessionBoundaryDraft`), and reads back what it appended. */
export interface DraftAppender {
	appendCustomEntry(customType: string, data?: unknown): string;
	appendCustomMessageEntry: (...args: DropState<typeof appends.appendCustomMessageEntry>) => string;
	appendContextEdit: (...args: DropState<typeof appends.appendContextEdit>) => string;
	getEntry(id: string): SessionEntry | undefined;
}

type DropState<F> = F extends (state: SessionState, ...args: infer A) => unknown ? A : never;

/** The session's index with entries of its own on top: what a preview appends stays out of the session. */
class OverlayIndex extends Map<string, SessionEntry> {
	private readonly base: ReadonlyMap<string, SessionEntry>;

	constructor(base: ReadonlyMap<string, SessionEntry>) {
		super();
		this.base = base;
	}

	override get(id: string): SessionEntry | undefined {
		return super.get(id) ?? this.base.get(id);
	}

	override has(id: string): boolean {
		return super.has(id) || this.base.has(id);
	}
}

/**
 * The projection at the state's leaf with what `apply` appends after it, without changing the session: the appends go
 * to an unsaved copy of the leaf that reads the session's entries. Undefined, before `apply` runs, when the leaf id names
 * no entry, and after it when an append changes which entries the context holds (a compaction): the caller then builds
 * the preview from a copy of the branch. Its entry and message arrays are its own; the entry records are the kept ones,
 * which the session replaces but never changes.
 */
export function previewProjection(
	state: SessionState,
	apply: (appender: DraftAppender) => void,
): ReadonlySessionProjection | undefined {
	if (state.leafId !== null && !state.byId.has(state.leafId)) return undefined;
	const base = leafParts(state);
	const scratch: SessionState = {
		...createSessionState(state.cwd, state.sessionDir, false),
		sessionId: state.sessionId,
		byId: new OverlayIndex(state.byId),
		leafId: state.leafId,
	};
	apply({
		appendCustomEntry: (customType, data) => appends.appendCustomEntry(scratch, customType, data),
		appendCustomMessageEntry: (...args) => appends.appendCustomMessageEntry(scratch, ...args),
		appendContextEdit: (...args) => appends.appendContextEdit(scratch, ...args),
		getEntry: (id) => scratch.byId.get(id),
	});
	return extendedProjection(base, scratch.fileEntries as SessionEntry[]);
}
