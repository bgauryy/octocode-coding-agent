import type { CommandContext } from "../../core/features/index.ts";
import { jobs } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { workspaceIdentity } from "../../storage/workspace.ts";
import { BacklogStore } from "./store.ts";
import { jobsOfRows, jobsOfRunningWork, linkRows } from "../graph/running.ts";
import { workGraph } from "../graph/model.ts";
import { readRunLockSnap } from "../graph/run-lock.ts";
import { readGraphSources } from "./graph-sources.ts";
import type { RunningWork } from "../shared/running-work.ts";

/**
 * What the work graph knows of each background job of this session, as text for `/jobs` after the command: ` · item B915`
 * and ` · holds full-run`. A job the graph knows nothing of has no entry.
 */
export function jobLinks(ctx: CommandContext, work: RunningWork, now: number): Map<string, string> {
	const agentDb = sharedAgentDb();
	const workspace = workspaceIdentity(ctx.cwd);
	const own = ctx.sessionManager.getSessionId();
	const graph = workGraph(
		readGraphSources({
			agentDb,
			// A plain store: reading the graph must not open the session's backlog context (its feeds and registrations).
			store: new BacklogStore(() => agentDb, workspace.id),
			repo: workspace.id,
			root: workspace.root,
			now,
			runLock: readRunLockSnap(),
			jobs: [jobsOfRunningWork(work), jobsOfRows(() => jobs.running(agentDb.db, workspace.id), own)],
		}),
	);
	const links = new Map<string, string>();
	for (const row of linkRows(work.all(), graph)) {
		if (row.kind !== "bash") continue;
		const text = [row.item && ` · item ${row.item}`, row.resource && ` · holds ${row.resource}`]
			.filter(Boolean)
			.join("");
		if (text) links.set(row.id, text);
	}
	return links;
}
