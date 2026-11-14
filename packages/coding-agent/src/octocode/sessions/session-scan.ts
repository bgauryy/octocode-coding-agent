// What a session's entries say: its spend, last activity, branch, pending subagent reports and goal name.
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { cleanTitle } from "../../core/session-manager/title.ts";
import { CLAIM_MARKER, pendingReportsDir } from "../subagents/handoff/pending.ts";
import type { SpendScan } from "../shared/spend.ts";
import { addUsage, emptyUsage, memoizedModelLookup, type ModelLookup, unpricedModel } from "../shared/util.ts";

export type Entry = {
	type?: string;
	timestamp?: string;
	message?: { role?: string; usage?: unknown; details?: unknown };
	customType?: string;
	details?: unknown;
};

/**
 * Cost and tokens of a session, read once at start; later replies are added as they end. A fork (or clone) starts with
 * its parent's history copied in, entries keeping their original times: those were paid for in the parent, so with a
 * `parentSession` only entries from the fork's own start (its header time) on count. The footer's and /session's entries
 * count (`SpendScan`): replies, a foreground subagent's `agent` result, a background subagent's report, `usage` entries
 * (compaction summaries, cache refreshes, side questions) and compaction and branch summaries.
 */
export function totals(
	entries: readonly Entry[],
	header: { timestamp?: string; parentSession?: string } | null | undefined,
	find: ModelLookup,
	scan: SpendScan,
): { usage: ReturnType<typeof emptyUsage>; unpriced: boolean } {
	const forkedAt = header?.parentSession ? Date.parse(header.timestamp ?? "") : Number.NaN;
	const usage = emptyUsage();
	const lookup = memoizedModelLookup(find);
	let unpriced = false;
	for (const entry of entries) {
		const spend = scan.entry(entry);
		if (!spend) continue;
		if (Number.isFinite(forkedAt) && Date.parse(entry.timestamp ?? "") < forkedAt) continue;
		addUsage(usage, spend.usage);
		unpriced ||= unpricedModel(spend, lookup) !== undefined;
	}
	return { usage, unpriced };
}

/** When the session was last active: its last entry's time, or undefined when Octocode recorded none. */
export function lastActive(entries: readonly Entry[]): number | undefined {
	const at = Date.parse(entries.at(-1)?.timestamp ?? "");
	return Number.isFinite(at) ? at : undefined;
}

/** The session's current branch (what the model sees), or all entries when Octocode offers no branch. */
export const branchOf = (ctx: ExtensionContext): readonly unknown[] =>
	ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];

/**
 * Ids of the subagents whose reports wait for this session's start (`reports/pending`, saved or being delivered): they
 * did not stop without a report, it arrives as a message. Empty when there are none or they cannot be read.
 */
export function pendingReportIds(sessionId: string): Set<string> {
	const ids = new Set<string>();
	try {
		const dir = pendingReportsDir(sessionId);
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".json") && !name.includes(`.json${CLAIM_MARKER}`)) continue;
			try {
				const id: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))?.details?.id;
				if (typeof id === "string") ids.add(id);
			} catch {
				// Delivered (removed) meanwhile, or not a report.
			}
		}
	} catch {
		// No reports wait for this session.
	}
	return ids;
}

/** A subagent's session is named for its goal, unless it already has a name (a resumed one). */
export function registerGoalName(api: ExtensionAPI, goal: string | undefined): void {
	const name = goal ? cleanTitle(goal, GOAL_NAME_MAX) : "";
	if (!name) return;
	api.on("session_start", async (_event, ctx) => {
		try {
			if (!ctx.sessionManager.getSessionName()) api.setSessionName(name, "goal");
		} catch {
			// The session was replaced: it keeps no goal name.
		}
	});
}

const GOAL_NAME_MAX = 200;

export const hasUserMessage = (entries: readonly Entry[]) =>
	entries.some((entry) => entry.type === "message" && entry.message?.role === "user");
