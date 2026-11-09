import { type AgentDb, type WorkspaceIdentity, workspaces } from "../../../db/src/api.ts";
import { workspaceGit } from "../utils/git-repository.ts";
import { sharedAgentDb } from "./database.ts";
import { workspaceIdentity } from "./workspace.ts";

/** Bind the on-disk declaration to this database before reading or writing workspace-owned records. */
export function registeredWorkspace(
	source: string | WorkspaceIdentity,
	agent: AgentDb = sharedAgentDb(),
): WorkspaceIdentity {
	const identity = typeof source === "string" ? workspaceIdentity(source) : source;
	workspaces.register(agent.db, { ...identity, git: workspaceGit(identity.root) });
	return identity;
}
