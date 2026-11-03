import path from "node:path";
import { type AgentDb, workspaces } from "../../../db/src/api.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";

/** Supply catalog parents for store tests that inject a workspace ID instead of opening a checkout. */
export function registerFixtureWorkspace(agent: AgentDb, id: string): string {
	const root = path.basename(id) === ".git" ? path.dirname(id) : id;
	if (workspaces.byId(agent.db, id)) return id;
	workspaces.register(agent.db, { id, root, name: path.basename(root), binding: id });
	return id;
}

export function fixtureBacklog(agent: () => AgentDb, workspaceId: string, now?: () => number): BacklogStore {
	return new BacklogStore(agent, registerFixtureWorkspace(agent(), workspaceId), now);
}
