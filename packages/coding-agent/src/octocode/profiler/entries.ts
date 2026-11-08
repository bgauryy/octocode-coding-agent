import { createHash } from "node:crypto";
import { collectCacheMisses, type CacheMiss } from "../../core/cache-stats.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * A transcript line as the profiler reads it. Entries are parsed JSON, so every field is optional until checked; fields
 * the recording side adds later (`requestTrace`, `origin`) are read defensively and may be absent.
 */
export type Entry = Record<string, unknown> & { type: string; id: string };

/** A parsed transcript with the lookups every derivation needs; build it once per file state with `prepare`. */
export interface Prepared {
	entries: Entry[];
	byId: Map<string, number>;
	/** Positions of the assistant entries that were requests (they report prompt tokens), oldest first. */
	requests: number[];
	/**
	 * Per request index, the index of the request before it on its own branch (parent links), undefined for the first.
	 * After `/tree` the file holds several branches; a request compares with its parent's request, not the one written
	 * just before it. Entries without parent links follow file order.
	 */
	previous: Array<number | undefined>;
	/** Misses `core/cache-stats.ts` counts, keyed by the assistant entry's position. */
	misses: Map<number, CacheMiss>;
}

/** Parses JSONL text; a line that is not a JSON object (a torn last write) is skipped. */
export function parseTranscript(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const value = JSON.parse(line) as Entry;
			if (typeof value.type === "string") entries.push(value);
		} catch {
			// A partially written line is read again once it is complete.
		}
	}
	return entries;
}

const noPrices = { getModel: () => undefined };

export function promptTokens(usage: Record<string, unknown>): number {
	return num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
}

export function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

export function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function sha(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** The assistant message of an entry that was a provider request, or undefined. */
function requestMessage(entry: Entry): Record<string, unknown> | undefined {
	if (entry.type !== "message") return undefined;
	const message = asRecord(entry.message);
	if (message.role !== "assistant") return undefined;
	return promptTokens(asRecord(message.usage)) > 0 ? message : undefined;
}

export function prepare(entries: Entry[]): Prepared {
	const byId = new Map<string, number>();
	const requests: number[] = [];
	const previous: Array<number | undefined> = [];
	// The latest request on the path ending at each entry.
	const latest = new Map<string, number | undefined>();
	let filed: number | undefined;
	entries.forEach((entry, position) => {
		if (typeof entry.id === "string") byId.set(entry.id, position);
		const parent = entry.parentId;
		const before =
			typeof parent === "string" && latest.has(parent) ? latest.get(parent) : parent === null ? undefined : filed;
		const message = requestMessage(entry);
		filed = message ? requests.length : before;
		if (typeof entry.id === "string") latest.set(entry.id, filed);
		if (!message) return;
		previous.push(before);
		// The miss scan reads `usage.cost`; an entry written without one counts as free.
		const usage = asRecord(message.usage);
		if (typeof usage.cost !== "object" || usage.cost === null)
			usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		message.usage = usage;
		requests.push(position);
	});
	const found = collectCacheMisses(entries as unknown as SessionEntry[], noPrices);
	const misses = new Map<number, CacheMiss>();
	for (const position of requests) {
		const miss = found.get(entries[position].message as never);
		if (miss) misses.set(position, miss);
	}
	return { entries, byId, requests, previous, misses };
}
