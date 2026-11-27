import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { type AgentDb, backlog, timers } from "../../../../db/src/api.ts";
import { workspaceDb } from "../../storage/workspace-database.ts";
import { shownLine } from "../sessions/store.ts";
import { runningWorkBrief } from "../sessions/compaction-brief.ts";
import { hadReportedWork, unreportedWork } from "../sessions/work.ts";
import { timerWorkRows } from "../timer/work.ts";

/**
 * The Recovery lines that state what the tools say is true when a summary is written: the backlog items this session
 * holds and the background bash jobs and subagents started in this process that have not reported. The model's own
 * summary can name an item it only meant to add or a job that is gone; these lines come from the backlog database and
 * the session's tool results, never from the model, so the next model checks the summary against them. Each line is one
 * Recovery bullet (`splitSummary` removes the section by that shape), rebuilt at every compaction, never carried.
 */

/** Characters kept of an item's title. */
const TITLE_CHARS = 100;

/**
 * The live-state lines for the session `ctx` belongs to. `entries` is its branch (the background work in its tool
 * results) and `since` when this process started its work (earlier starts ended with an earlier process). An
 * unreadable backlog database is said in a line, not left out: a missing list would read as "holds nothing".
 */
export function liveStateLines(
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
	entries: readonly unknown[],
	since: number,
): string[] {
	const lines: string[] = [];
	let agent: AgentDb | undefined;
	try {
		const bound = workspaceDb(ctx.cwd);
		agent = bound.agent;
		const repoKey = bound.workspace.id;
		const rows = backlog.ongoingItems(agent.db, repoKey, ctx.sessionManager.getSessionId());
		// Held items are listed once, with their goals, by the session-state brief sent after the compaction
		// (`sessions/brief.ts`, read from the same table later); this block only states that there are none.
		if (rows.length === 0) lines.push(renderPrompt("notices/recovery/live-items.md"));
	} catch {
		lines.push(renderPrompt("notices/recovery/live-unreadable.md"));
	}
	const work = runningWorkBrief(entries, since, ctx.sessionManager.getSessionFile());
	if (work.length > 0) lines.push(renderPrompt("notices/recovery/live-work.md", { work: work.join("; ") }));
	else if (hadReportedWork(entries) && unreportedWork(entries).length === 0)
		lines.push(renderPrompt("notices/recovery/live-none.md"));
	const active = agent ? activeTimers(agent, ctx) : [];
	if (active.length > 0) lines.push(renderPrompt("notices/recovery/live-timers.md", { timers: active.join("; ") }));
	return lines;
}

/** The session's active timers as `#3 until command exits 0 (note), due 2026-…Z`, read from the timer table. */
function activeTimers(agent: AgentDb, ctx: Pick<FeatureContext, "sessionManager">): string[] {
	try {
		const rows = timers.forSession(agent.db, ctx.sessionManager.getSessionId());
		return timerWorkRows(rows).map((row) => {
			const note = row.detail ? ` (${shownLine(row.detail, TITLE_CHARS)})` : "";
			const due = row.dueAt === undefined ? "" : `, due ${new Date(row.dueAt).toISOString()}`;
			return `${row.id} ${shownLine(row.title, TITLE_CHARS)}${note}${due}`;
		});
	} catch {
		return [];
	}
}
