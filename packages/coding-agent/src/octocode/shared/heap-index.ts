import fs from "node:fs";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";

/**
 * The session's heap index: the objects its context points at instead of holding (file reads the model saw, with the
 * version and range each showed), each named by a short handle. Bounded: past `HEAP_INDEX_CAP` the least recently used
 * entry goes, and its next read simply returns the text. The index only remembers; the saved copies of cleared results
 * stay in the session's output folder (`compaction/saved-results.ts`), and `clearing.ts` decides what leaves the context.
 */

/** The most entries one session's index keeps. */
export const HEAP_INDEX_CAP = 256;

/** Hex characters of a version's digest in a handle: 48 bits, enough to tell one session's file versions apart. */
const HANDLE_DIGEST_CHARS = 12;

/**
 * The handle of a file Octocode saved (a cleared or bounded result, a log, a transcript): `saved:<8 hex>` of its last
 * three path parts (`<session>/output/<name>`), so absolute, relative and `~` spellings of one file share it.
 */
export const savedHandle = (file: string): string =>
	`saved:${sha256(file.split(/[\\/]/).slice(-3).join("/")).slice(0, 8)}`;

/** What a read showed of a file: the whole text or an inclusive line range. */
export type HeapRange = "all" | readonly [number, number];

export const rangeText = (range: HeapRange): string => (range === "all" ? "all" : `${range[0]}-${range[1]}`);

/** The handle of one version of a file's text, optionally of one line range: `file:<digest>` or `file:<digest>@A-B`. */
export function fileHandle(version: string, range: HeapRange = "all"): string {
	const digest = version.startsWith("sha:") ? version.slice(4) : sha256(version);
	return `file:${digest.slice(0, HANDLE_DIGEST_CHARS)}${range === "all" ? "" : `@${rangeText(range)}`}`;
}

/** One object the context shows: the call whose result holds its text, and what that text was a view of. */
export interface HeapEntry {
	handle: string;
	path: string;
	range: HeapRange;
	/** The file's version when read (`sha:<sha256>` or a stat identity). */
	version: string;
	/** The tool call whose result showed it. */
	callId: string;
	/** A reader's call arguments; absent for bash. */
	input?: Record<string, unknown>;
	/** Answered with a note once: the next read of it gets the text. */
	noted?: boolean;
}

const keyOf = (path: string, range: HeapRange): string => `${path}\0${rangeText(range)}`;

/** A bounded, least-recently-used map from (path, range) to the latest view of it. */
export class HeapIndex {
	readonly #entries = new Map<string, HeapEntry>();

	readonly cap: number;

	constructor(cap = HEAP_INDEX_CAP) {
		this.cap = cap;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** The latest view of `path` over `range`; reading it counts as use. */
	find(path: string, range: HeapRange): HeapEntry | undefined {
		const key = keyOf(path, range);
		const entry = this.#entries.get(key);
		if (entry) {
			this.#entries.delete(key);
			this.#entries.set(key, entry);
		}
		return entry;
	}

	/** Replaces the view of the entry's (path, range) and evicts the oldest entries past the cap. */
	record(entry: Omit<HeapEntry, "handle">): HeapEntry {
		const stored: HeapEntry = { ...entry, handle: fileHandle(entry.version, entry.range) };
		const key = keyOf(entry.path, entry.range);
		this.#entries.delete(key);
		this.#entries.set(key, stored);
		while (this.#entries.size > this.cap) this.#entries.delete(this.#entries.keys().next().value as string);
		return stored;
	}

	/** The path a handle in this index names, without counting as use. */
	pathOf(handle: string): string | undefined {
		for (const entry of this.#entries.values()) if (entry.handle === handle) return entry.path;
		return undefined;
	}

	/** Handle and path of every entry, oldest use first: what a child's `ParentHeap` is built from. */
	entries(): Array<{ handle: string; path: string }> {
		return [...this.#entries.values()].map(({ handle, path }) => ({ handle, path }));
	}
}

/** What a handle stands for in a parent's heap. */
export type HandleResolution = { status: "ok"; path: string } | { status: "expired"; reply: string };

/** The explicit reply for a handle that no longer resolves: never an empty result. */
export const expiredReply = (handle: string): string =>
	`[Handle ${handle} expired: its object is no longer kept. Run the original read or call again.]`;

/**
 * A parent's heap as a child sees it: handles to read, nothing to change. It holds a frozen copy of handle and path
 * pairs and has no way to add, replace or write: a child's own objects live in its own index, and the file tool never
 * changes a path in Octocode's state folder (`protectedFileRefusal`).
 */
export class ParentHeap {
	readonly #paths: ReadonlyMap<string, string>;

	constructor(entries: ReadonlyArray<{ handle: string; path: string }>) {
		this.#paths = new Map(entries.map((entry) => [entry.handle, entry.path]));
	}

	get size(): number {
		return this.#paths.size;
	}

	/** The path to read for `handle`, or the expired reply when the handle is unknown or its file is gone. */
	resolve(handle: string): HandleResolution {
		const path = this.#paths.get(handle);
		return path !== undefined && fs.existsSync(path)
			? { status: "ok", path }
			: { status: "expired", reply: expiredReply(handle) };
	}
}
