import type { AgentDb } from "../../../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../../storage/database.ts";
import { openWorkspaceDb, workspaceDb } from "../../../storage/workspace-database.ts";
import { teamWorkspace } from "./workspace.ts";

/**
 * The files a team store reads: the file of the team's checkout (`teamWorkspace`), holding the roster, mail, leases,
 * edits, runs and presence events of the repository's worktrees, and the machine file, holding the session rows.
 */
export interface TeamFiles {
	agent: AgentDb;
	machine: AgentDb;
	/** Closes the connections `openTeamFiles` made; the shared ones stay open. */
	close(): void;
}

/** The process's connections (`sharedAgentDb`, `workspaceDb`), which sessions, memory and backlog use too. */
export function sharedTeamFiles(cwd: string, env: NodeJS.ProcessEnv): TeamFiles {
	return { agent: workspaceDb(teamWorkspace(cwd, env), env).agent, machine: sharedAgentDb(env), close: () => {} };
}

/** Own connections on the machine file `file` and on its workspace file of `cwd`'s team. */
export function openTeamFiles(cwd: string, file: string, env: NodeJS.ProcessEnv): TeamFiles {
	const machine = openAgentDb(file, env);
	try {
		const { agent } = openWorkspaceDb(machine, teamWorkspace(cwd, env), env);
		return {
			agent,
			machine,
			close: () => {
				if (agent !== machine) agent.close();
				machine.close();
			},
		};
	} catch (error) {
		machine.close();
		throw error;
	}
}
