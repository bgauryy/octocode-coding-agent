import fs from "node:fs";
import type { ProfilerMember } from "./service.ts";
import { memberTranscript } from "./transcripts.ts";
import { agentRuns, dbStamp, sessions, type AgentRun, type Db } from "../../../../db/src/api.ts";

/** A stored run as the profiler lists its agent; the coordinator (`self`) is `main` and has no outcome. */
export const runMember = (run: AgentRun, self: boolean): ProfilerMember => ({
	id: run.agentId,
	role: self ? "main" : (run.profile ?? "general"),
	status: "idle",
	...(run.parentAgentId && !self ? { parentId: run.parentAgentId } : {}),
	...(run.model ? { model: run.model } : {}),
	...(run.goal ? { goal: run.goal } : {}),
	joinedAt: run.startedAt,
	updatedAt: run.endedAt ?? run.startedAt,
	...(run.endedAt && !self ? { outcome: run.outcome ?? run.endReason ?? "done" } : {}),
});

/** The runs of a session tree: the coordinator's own run, and each other agent once, by its latest run. */
export interface SessionRuns {
	all: AgentRun[];
	coordinator: AgentRun | undefined;
	children: Map<string, AgentRun>;
}

export function sessionRuns(db: Db, sessionId: string): SessionRuns {
	const all = agentRuns.inSessionTree(db, sessionId);
	const coordinator = all.find((run) => run.sessionId === sessionId);
	// A name can run more than once; the profiler lists an agent once, by its latest run.
	const children = new Map<string, AgentRun>();
	for (const run of all) if (run.agentId !== coordinator?.agentId) children.set(run.agentId, run);
	return { all, coordinator, children };
}

/** The run's transcript: its session's catalog file, else what the team database records for the agent. */
export function runTranscript(
	db: Db,
	run: AgentRun,
	files: ReadonlyMap<string, string>,
	machine: Db = db,
): string | undefined {
	const file = run.sessionId ? files.get(run.sessionId) : undefined;
	if (file && fs.existsSync(file)) return file;
	return memberTranscript(db, { id: run.agentId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) }, machine);
}

export const catalogFiles = (db: Db): Map<string, string> =>
	new Map(sessions.catalog(db).map((row) => [row.id, row.file]));

/**
 * The ended agents of a session tree for the live profiler. The recursive run query and the catalog read run once per
 * database state (`dbStamp`: every writer moves it), not once per 1 s poll; between writes a poll costs two stats.
 * `database` holds the runs, `machine` the session rows (the same file while they share one).
 */
export function endedRuns(
	database: () => { db: Db; file: string },
	sessionId: string,
	machine: () => { db: Db } = database,
) {
	let cached: { stamp: string; runs: SessionRuns; files?: Map<string, string> } | undefined;
	const current = () => {
		const { db, file } = database();
		const stamp = dbStamp(file);
		if (cached?.stamp !== stamp) cached = { stamp, runs: sessionRuns(db, sessionId) };
		return { db, state: cached };
	};
	return {
		/** Members that are not in `skip` (the live ids): the latest run of each other agent, excluding the coordinator. */
		members(skip: ReadonlySet<string>): ProfilerMember[] {
			return [...current().state.runs.children.values()]
				.filter((run) => !skip.has(run.agentId))
				.map((run) => runMember(run, false));
		},
		transcript(agentId: string): string | undefined {
			const { db, state } = current();
			const run = state.runs.children.get(agentId);
			if (!run) return undefined;
			state.files ??= catalogFiles(machine().db);
			return runTranscript(db, run, state.files, machine().db);
		},
	};
}
