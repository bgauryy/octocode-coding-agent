import { isRecord } from "../../../utils/guards.ts";
import { entryMessage, type Spend, spendOf } from "../../shared/util.ts";

/**
 * The spend a session entry carries: a reply's or subagent's (`entryMessage`), or the summarizing call a `compaction` or
 * `branch_summary` entry records in `usage`. The built-in footer counts the same entries.
 */
export function entrySpend(entry: unknown): Spend | undefined {
	if (isRecord(entry) && (entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.usage))
		return { role: entry.type, usage: entry.usage };
	return spendOf(entryMessage(entry));
}

const THINKING_SHORT: Record<string, string> = { minimal: "min", medium: "med" };

/** A thinking level in fewer cells for a narrow row. */
export const shortThinking = (level: string) => THINKING_SHORT[level] ?? level;
