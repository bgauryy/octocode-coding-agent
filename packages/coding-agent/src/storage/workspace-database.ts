import {
	type AgentDb,
	type WorkspaceIdentity,
	isBusy,
	transactionWhenReady,
	withoutWaiting,
	workspaces,
} from "../../../db/src/api.ts";
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

/** The usual unchanged registration stays a read; only a contended metadata write waits asynchronously. */
export async function registeredWorkspaceWhenReady(
	source: string | WorkspaceIdentity,
	agent: AgentDb,
	signal?: AbortSignal,
): Promise<WorkspaceIdentity> {
	signal?.throwIfAborted();
	const identity = typeof source === "string" ? workspaceIdentity(source) : source;
	const registration = { ...identity, git: workspaceGit(identity.root) };
	try {
		withoutWaiting(agent.db, () => workspaces.register(agent.db, registration));
	} catch (error) {
		if (!isBusy(error)) throw error;
		await transactionWhenReady(agent, () => workspaces.register(agent.db, registration), signal);
	}
	return identity;
}
