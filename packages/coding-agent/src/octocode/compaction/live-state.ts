import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { backlog } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import { shownLine } from "../sessions/store.ts";
import { describeWork, unreportedWork } from "../sessions/work.ts";

/**
 * The Recovery lines that state what the tools say is true when a summary is written: the backlog items this session
 * holds and the background bash jobs and subagents started in this process that have not reported. The model's own
 * summary can name an item it only meant to add or a job that is gone; these lines come from the backlog database and
 * the session's tool results, never from the model, so the next model checks the summary against them. Each line is one
 * Recovery bullet (`splitSummary` removes the section by that shape), rebuilt at every compaction, never carried.
 */

/** Items named one by one; the rest are counted. */
const MAX_ITEMS = 8;
/** Characters kept of an item's title. */
const TITLE_CHARS = 100;

/** The held items as `B7 ongoing "title"`, the first `MAX_ITEMS`, then how many more. */
function itemsText(rows: ReadonlyArray<{ seq: number; title: string }>): string {
	const named = rows.slice(0, MAX_ITEMS).map((row) => `B${row.seq} ongoing "${shownLine(row.title, TITLE_CHARS)}"`);
	if (rows.length > MAX_ITEMS) named.push(`${rows.length - MAX_ITEMS} more (backlog list shows them)`);
	return named.join("; ");
}

/**
 * The live-state lines for the session `ctx` belongs to. `entries` is its branch (the background work in its tool
 * results) and `since` when this process started its work (earlier starts ended with an earlier process). An
 * unreadable backlog database is said in a line, not left out: a missing list would read as "holds nothing".
 */
export function liveStateLines(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	entries: readonly unknown[],
	since: number,
): string[] {
	const lines: string[] = [];
	try {
		const agent = sharedAgentDb();
		const repoKey = registeredWorkspace(ctx.cwd, agent).id;
		const rows = backlog.ongoingItems(agent.db, repoKey, ctx.sessionManager.getSessionId());
		lines.push(renderInstruction("notices/recovery/live-items.md", { items: itemsText(rows) }));
	} catch {
		lines.push(renderInstruction("notices/recovery/live-unreadable.md"));
	}
	const work = unreportedWork(entries, since).map((item) => describeWork(item, false));
	if (work.length > 0) lines.push(renderInstruction("notices/recovery/live-work.md", { work: work.join("; ") }));
	return lines;
}
