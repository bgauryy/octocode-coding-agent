import type { ProfileCacheGroup } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { CACHE_GROUP_ENTRY } from "../shared/cache-group-entry.ts";
import type { Entry, Prepared } from "./entries.ts";

function groupOf(entry: Entry | undefined): ProfileCacheGroup | undefined {
	if (!entry || entry.type !== "custom" || entry.customType !== CACHE_GROUP_ENTRY) return undefined;
	const data = asRecord(entry.data);
	if (data.version !== 1 || typeof data.prefix !== "string") return undefined;
	return { prefix: data.prefix, ...(typeof data.key === "string" ? { key: data.key } : {}) };
}

/** Whether the transcript recorded a cache group at all; only children do, so most transcripts skip the walk. */
export function hasCacheGroup(entries: readonly Entry[]): boolean {
	return entries.some((entry) => groupOf(entry) !== undefined);
}

/** The cache group in force at the entry at `position`: the nearest recorded one on its own branch (parent links). */
export function cacheGroupAt(prepared: Prepared, position: number): ProfileCacheGroup | undefined {
	const seen = new Set<number>();
	let at: number | undefined = position;
	while (at !== undefined && !seen.has(at)) {
		seen.add(at);
		const found = groupOf(prepared.entries[at]);
		if (found) return found;
		const parent: unknown = prepared.entries[at].parentId;
		at = typeof parent === "string" ? prepared.byId.get(parent) : undefined;
	}
	return undefined;
}

/** The provider's own `cache_miss` reason on an assistant message (`tools_changed`), whether or not Octocode counted a miss. */
export function providerMissReason(message: Record<string, unknown>): string | undefined {
	const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
	for (const item of diagnostics) {
		const row = asRecord(item);
		if (row.type !== "cache_miss") continue;
		const reason = asRecord(row.details).reason;
		if (typeof reason === "string" && reason) return reason;
	}
	return undefined;
}
