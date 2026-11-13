import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { EntryCursor, type AppendedEntries, type EntrySource } from "./entry-cursor.ts";
import { entryMessage, type Spend, spendOf } from "./util.ts";

/**
 * The spend a session entry carries: a reply's or subagent's (`entryMessage`), the summarizing call a `compaction` or
 * `branch_summary` entry records in `usage`, or a `usage` entry (a request made outside a reply: the default compaction
 * summary, a cache refresh, a side question; it names the model that answered). The footer and the agent list read the
 * session through this, so they total the same entries.
 */
function entrySpend(entry: unknown): Spend | undefined {
	if (!isRecord(entry)) return undefined;
	if ((entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.usage))
		return { role: entry.type, usage: entry.usage };
	if (entry.type === "usage" && isRecord(entry.usage))
		return { role: "usage", usage: entry.usage, provider: entry.provider, model: entry.model };
	return spendOf(entryMessage(entry));
}

/**
 * Counts the spend a surface totals one entry at a time. No extension event announces a `usage` entry, so a surface finds
 * them by looking at the session again and again; each is counted once, by id. `recordedIn` looks only at the entries
 * appended since its last look (`EntryCursor`), and at the whole session when that cannot be proven.
 */
export class SpendScan {
	private readonly counted = new Set<string>();
	private readonly cursor = new EntryCursor();

	/** Forgets what was counted (a session replay starts the totals over) and where `recordedIn` stopped. */
	reset(): void {
		this.counted.clear();
		this.cursor.reset();
	}

	/** The session's entries since the last `appended` or `recordedIn` (all of them after `reset`), for a surface's own fold. */
	appended(session: EntrySource): AppendedEntries {
		return this.cursor.next(session);
	}

	/** `recorded` over the entries the session gained since the last look: the same spends, without reading it whole. */
	recordedIn(session: EntrySource): Spend[] {
		return this.recorded(this.cursor.next(session).entries);
	}

	/** `entrySpend`, but a `usage` entry only once. */
	entry(entry: unknown): Spend | undefined {
		if (isRecord(entry) && entry.type === "usage" && typeof entry.id === "string") {
			if (this.counted.has(entry.id)) return undefined;
			this.counted.add(entry.id);
		}
		return entrySpend(entry);
	}

	/** The spend of every `usage` entry in `entries` not counted before. */
	recorded(entries: Iterable<unknown>): Spend[] {
		const found: Spend[] = [];
		for (const entry of entries) {
			if (!isRecord(entry) || entry.type !== "usage") continue;
			const spend = this.entry(entry);
			if (spend) found.push(spend);
		}
		return found;
	}
}
