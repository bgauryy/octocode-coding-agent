/**
 * When each named thing (a tool) was last used, per scope (a working directory), in one small JSON file:
 * `{ "<scope>": { "<name>": <lastUsedMs> } }`. Readers ask which names were used inside a window; a name outside it is
 * gone at the next write, so the file holds at most what was used in one window.
 *
 * The record is a hint, never a source of truth: an unreadable or malformed file reads as "nothing was used", and two
 * processes writing at once can lose one update (the file is replaced whole). Both only make a tool look unused once
 * more, which costs its reader one schema read. Nothing here throws.
 */

import fs from "node:fs";
import { atomicWriteFileSync } from "./atomic-file.ts";

/** A tool unused for this long is no longer in use. */
export const RECENT_USE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One process rewrites the file for the same name at most this often. */
const WRITE_INTERVAL_MS = 10 * 60 * 1000;

type Uses = Record<string, Record<string, number>>;

function load(file: string): Uses {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const uses: Uses = {};
		for (const [scope, names] of Object.entries(value)) {
			if (typeof names !== "object" || names === null || Array.isArray(names)) continue;
			const kept: Record<string, number> = {};
			for (const [name, at] of Object.entries(names))
				if (typeof at === "number" && Number.isFinite(at)) kept[name] = at;
			uses[scope] = kept;
		}
		return uses;
	} catch {
		return {};
	}
}

/** The names used in `scope` within `windowMs` before `now`. Empty when the file is missing or unreadable. */
export function recentlyUsed(
	file: string,
	scope: string,
	now: number = Date.now(),
	windowMs: number = RECENT_USE_WINDOW_MS,
): Set<string> {
	const names = load(file)[scope] ?? {};
	return new Set(Object.keys(names).filter((name) => now - names[name] < windowMs));
}

/** Records uses of names in one scope of one file, rewriting it at most once per name per interval. */
export class RecentUseRecorder {
	readonly #file: () => string;
	readonly #windowMs: number;
	readonly #written = new Map<string, number>();

	constructor(file: () => string, windowMs: number = RECENT_USE_WINDOW_MS) {
		this.#file = file;
		this.#windowMs = windowMs;
	}

	/** Marks `name` as used in `scope` now. Never throws: a failed write leaves the record as it was. */
	record(scope: string, name: string, now: number = Date.now()): void {
		const key = `${scope}\0${name}`;
		const last = this.#written.get(key);
		if (last !== undefined && now - last < WRITE_INTERVAL_MS) return;
		this.#written.set(key, now);
		try {
			const file = this.#file();
			const uses = load(file);
			const pruned: Uses = {};
			for (const [each, names] of Object.entries(uses)) {
				const kept = Object.fromEntries(Object.entries(names).filter(([, at]) => now - at < this.#windowMs));
				if (Object.keys(kept).length > 0) pruned[each] = kept;
			}
			pruned[scope] = { ...pruned[scope], [name]: now };
			atomicWriteFileSync(file, `${JSON.stringify(pruned)}\n`);
		} catch {
			// The record is a hint; the next use tries again after the interval.
		}
	}
}
